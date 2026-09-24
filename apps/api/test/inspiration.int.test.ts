/**
 * Inspiration como tablero de referencias propio — `POST|GET /inspiration`,
 * `GET /inspiration/tags`, `GET|PATCH|DELETE /inspiration/:itemId`,
 * `POST /inspiration/:itemId/remix` (FR-040 adaptado, OQ-13, migración `0022`).
 *
 * Lo que persigue este archivo:
 *
 *  - guardar un link deja la fila `pending` y el job de lectura en
 *    `media-import` (con `inspirationItemId`) **en la misma transacción**; con
 *    `saveClip`, además, el import por link de siempre;
 *  - un clip del Media Bank se guarda `ready` sin job; uno ajeno es 404;
 *  - búsqueda, filtro por formato y etiqueta, y etiquetas en uso;
 *  - ajena, inexistente y no-uuid son el mismo 404 en las cinco rutas con id,
 *    y el 404 no deja efectos (ni filas ni jobs);
 *  - el remix es `POST /blitz/generate` con la referencia: pedido con
 *    `source_trending_item_id` y job en `discovery-refill`; al cerrarlo (lo
 *    que hace el worker, con la función real de `db`) las piezas salen en
 *    `GET /blitz/queue` con `remixSource` poblado ("Remixed From", F-056).
 *
 * El worker no corre acá: la lectura con `yt-dlp` la mide
 * `apps/worker/src/inspiration/ingest-handler.test.ts`. No hace `TRUNCATE`:
 * crea sus propios workspaces.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import {
  blitzQueueSchema,
  generateBlitzAcceptedSchema,
  inspirationItemSchema,
  numberedPaginationSchema,
} from "@fastgram/contracts";
import { JOB_QUEUES, REMIX_DEFAULT_PROMPT } from "@fastgram/core";
import {
  APP_ROLE,
  apiKeys,
  companies,
  companyProfiles,
  completePromptRequest,
  createDb,
  lockPromptRequest,
  media,
  migrateWithUrl,
  users,
  withCompany,
  withoutCompany,
  type DbHandle,
} from "@fastgram/db";

import { buildServer } from "../src/server/app.js";
import { generateApiKey } from "../src/auth/api-keys.js";
import { IdempotencyGuard } from "../src/http/idempotency.js";
import { createDbIdempotencyStore } from "../src/support/idempotency-store.js";
import { RecordingQueue, openLimiter } from "./helpers/harness.js";

import { DATABASE_URL } from "./helpers/fixtures.js";

const NOW = "2026-09-24T12:00:00.000Z";
const YT = "https://www.youtube.com/watch?v=MvV6i0zyDsc";

let handle: DbHandle;
let app: FastifyInstance;
let queue: RecordingQueue;

interface Workspace {
  readonly companyId: string;
  readonly token: string;
}

async function nuevoWorkspace(): Promise<Workspace> {
  return withoutCompany(handle.db, async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        externalIdentityId: `test_${randomUUID()}`,
        email: `insp-${randomUUID()}@test.local`,
        fullName: "inspiration",
        timezone: "UTC",
      })
      .returning({ id: users.id });
    if (user === undefined) throw new Error("no se creó el user");
    const [company] = await tx
      .insert(companies)
      .values({
        name: `insp ${randomUUID().slice(0, 8)}`,
        ownerUserId: user.id,
        status: "active",
        planId: "growth",
        subscriptionStatus: "active",
        billingAnchorDay: 1,
        timezone: "UTC",
      })
      .returning({ id: companies.id });
    if (company === undefined) throw new Error("no se creó la company");
    await tx.insert(companyProfiles).values({
      companyId: company.id,
      status: "ready",
      coreIdentity: "cafetería",
    });
    const key = generateApiKey();
    await tx.insert(apiKeys).values({
      companyId: company.id,
      label: "insp",
      hash: key.hash,
      kind: "workspace",
    });
    return { companyId: company.id, token: key.token };
  });
}

interface Respuesta {
  status: number;
  body: {
    data?: unknown;
    pagination?: unknown;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
}

async function pedir(
  ws: Workspace,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
  idempotencyKey?: string,
): Promise<Respuesta> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      authorization: `Bearer ${ws.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(idempotencyKey === undefined ? {} : { "idempotency-key": idempotencyKey }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return {
    status: res.statusCode,
    body: res.body === "" ? {} : (JSON.parse(res.body) as Respuesta["body"]),
  };
}

const item = (res: Respuesta) => inspirationItemSchema.parse(res.body.data);

function jobsDe(ws: Workspace, cola: string) {
  return queue
    .forQueue(cola)
    .filter((j) => (j.payload as { companyId?: string }).companyId === ws.companyId);
}

/** Lo que escribiría el worker después de leer la página. */
async function simularLectura(
  id: string,
  campos: {
    title: string;
    caption?: string;
    format: "video" | "slideshow" | "image" | "text";
    views?: number | null;
    likes?: number | null;
    hashtags?: string[];
  },
): Promise<void> {
  await handle.sql`
    update trending_items
       set ingest_state = 'ready',
           title = ${campos.title},
           caption = ${campos.caption ?? null},
           format = ${campos.format},
           views = ${campos.views ?? null},
           likes = ${campos.likes ?? null},
           hashtags = ${campos.hashtags ?? []}::text[],
           thumbnail_url = 'https://bucket.test/inspiration/thumb.jpg'
     where id = ${id}::uuid
  `;
}

async function sembrarMedia(ws: Workspace, mediaType: "image" | "video") {
  const mediaId = randomUUID();
  const ext = mediaType === "image" ? "jpg" : "mp4";
  const url = `https://bucket.test/media/${ws.companyId}/${mediaId}.${ext}`;
  await withoutCompany(handle.db, (tx) =>
    tx.insert(media).values({
      mediaId,
      companyId: ws.companyId,
      mediaType,
      filename: `clip.${ext}`,
      r2Url: url,
      storageKey: `media/${ws.companyId}/${mediaId}.${ext}`,
      status: "ready",
      sizeMb: 1,
      categories: mediaType === "image" ? [] : ["background-video"],
      origin: "manual_upload",
    }),
  );
  return { mediaId, url };
}

beforeAll(async () => {
  await migrateWithUrl(DATABASE_URL);
  handle = createDb({ url: DATABASE_URL, max: 10, onnotice: () => {} });
  const clock = new FixedClock(NOW);
  queue = new RecordingQueue();
  app = await buildServer({
    deps: {
      db: handle.db,
      clock,
      storage: new MemoryStorage(clock),
      limiter: openLimiter(clock),
      idempotency: new IdempotencyGuard(
        createDbIdempotencyStore({ db: handle.db, appRole: APP_ROLE }),
        clock,
      ),
      appRole: APP_ROLE,
      queue,
    },
    logLevel: "silent",
  });
  await app.ready();
}, 120_000);

beforeEach(() => {
  queue.reset();
});

afterAll(async () => {
  await app?.close();
  await handle?.close();
});

describe("POST /inspiration con un link", () => {
  it("201 pending, origen del dueño, y el job de lectura en media-import en la misma transacción", async () => {
    const ws = await nuevoWorkspace();
    const res = await pedir(ws, "POST", "/inspiration", {
      url: `  ${YT}  `,
      tags: ["Hooks", "hooks", " pov "],
    });
    expect(res.status).toBe(201);
    const it1 = item(res);
    expect(it1).toMatchObject({
      platform: "youtube",
      url: YT,
      ingestState: "pending",
      tags: ["hooks", "pov"],
      format: null,
      hashtags: [],
      onScreenText: [],
    });
    // Sin métricas hasta leer la página: ausentes, no `0`.
    expect(it1.views).toBeUndefined();
    expect(it1.likes).toBeUndefined();

    const [row] = await handle.sql`
      select origin, company_id, ingest_state from trending_items where id = ${it1.id}::uuid
    `;
    expect(row).toEqual({
      origin: "owner",
      company_id: ws.companyId,
      ingest_state: "pending",
    });

    const jobs = jobsDe(ws, JOB_QUEUES.mediaImport);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({
      companyId: ws.companyId,
      inspirationItemId: it1.id,
      url: YT,
    });
    expect(jobs[0]?.options?.transaction).toBeDefined();
    expect(jobs[0]?.options?.singletonKey).toBe(`inspiration:${it1.id}`);
  });

  it("con saveClip encola también el import por link de siempre y deja su estado consultable", async () => {
    const ws = await nuevoWorkspace();
    const it1 = item(
      await pedir(ws, "POST", "/inspiration", { url: YT, saveClip: true }),
    );
    expect(it1.importId).toBeDefined();
    expect(it1.mediaId).toBeDefined();
    const jobs = jobsDe(ws, JOB_QUEUES.mediaImport);
    expect(jobs).toHaveLength(2);
    const importJob = jobs.find(
      (j) => (j.payload as { importId?: string }).importId !== undefined,
    );
    expect(importJob?.payload).toEqual({
      companyId: ws.companyId,
      importId: it1.importId,
      mediaId: it1.mediaId,
      url: YT,
      kind: "video",
      categories: [],
    });
    const estado = await pedir(ws, "GET", `/media/import/${it1.importId ?? ""}`);
    expect(estado.status).toBe(200);
    expect(estado.body.data).toMatchObject({ state: "queued", sourceUrl: YT });
  });

  it("400 sin link ni clip, con los dos, y con un link a la red local (sin fila ni job)", async () => {
    const ws = await nuevoWorkspace();
    const ninguno = await pedir(ws, "POST", "/inspiration", {});
    expect(ninguno.status).toBe(400);
    const ambos = await pedir(ws, "POST", "/inspiration", {
      url: YT,
      mediaId: randomUUID(),
    });
    expect(ambos.status).toBe(400);
    const local = await pedir(ws, "POST", "/inspiration", {
      url: "http://127.0.0.1:3000/x",
    });
    expect(local.status).toBe(400);
    expect(local.body.error?.details?.["reason"]).toBe("unsupported_url");

    const [n] = await handle.sql`
      select count(*)::int as n from trending_items where company_id = ${ws.companyId}::uuid
    `;
    expect(n?.["n"]).toBe(0);
    expect(jobsDe(ws, JOB_QUEUES.mediaImport)).toHaveLength(0);
  });
});

describe("POST /inspiration con un clip del Media Bank", () => {
  it("una imagen propia: ready, formato image, su URL como miniatura, sin job", async () => {
    const ws = await nuevoWorkspace();
    const { mediaId, url } = await sembrarMedia(ws, "image");
    const res = await pedir(ws, "POST", "/inspiration", { mediaId, tags: ["meme"] });
    expect(res.status).toBe(201);
    expect(item(res)).toMatchObject({
      platform: null,
      url: null,
      format: "image",
      ingestState: "ready",
      mediaId,
      thumbnailUrl: url,
      title: "clip.jpg",
      tags: ["meme"],
    });
    expect(jobsDe(ws, JOB_QUEUES.mediaImport)).toHaveLength(0);
  });

  it("un clip de otra marca, uno inexistente y un id que no es uuid: 404", async () => {
    const a = await nuevoWorkspace();
    const b = await nuevoWorkspace();
    const ajeno = await sembrarMedia(b, "video");
    for (const mediaId of [ajeno.mediaId, randomUUID(), "no-es-uuid"]) {
      const res = await pedir(a, "POST", "/inspiration", { mediaId });
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe("not_found");
    }
    const [n] = await handle.sql`
      select count(*)::int as n from trending_items where company_id = ${a.companyId}::uuid
    `;
    expect(n?.["n"]).toBe(0);
  });
});

describe("GET /inspiration: búsqueda, filtros y etiquetas", () => {
  it("combina búsqueda, formato y etiqueta; pagina; lista las etiquetas en uso", async () => {
    const ws = await nuevoWorkspace();
    const otra = await nuevoWorkspace();
    const crear = async (url: string, tags: string[]) =>
      item(await pedir(ws, "POST", "/inspiration", { url, tags })).id;
    const a = await crear("https://www.tiktok.com/@a/video/1", ["hooks"]);
    const b = await crear("https://www.instagram.com/p/abc/", ["hooks", "carousel"]);
    const c = await crear("https://x.com/a/status/1", ["copy"]);
    await simularLectura(a, {
      title: "POV: tu primer café",
      caption: "El 50% de la gente no sabe esto #coffee",
      format: "video",
      views: 1300000,
      likes: 106800,
      hashtags: ["coffee"],
    });
    await simularLectura(b, { title: "5 errores", format: "slideshow" });
    await simularLectura(c, { title: "Hilo sobre precios", format: "text" });
    // Una referencia de otra marca con el mismo texto no aparece nunca.
    const ajena = item(
      await pedir(otra, "POST", "/inspiration", { url: YT, tags: ["hooks"] }),
    );
    await simularLectura(ajena.id, { title: "POV: tu primer café", format: "video" });

    const listar = async (qs: string) => {
      const res = await pedir(ws, "GET", `/inspiration${qs}`);
      expect(res.status).toBe(200);
      return {
        ids: (res.body.data as unknown[]).map((d) => inspirationItemSchema.parse(d).id),
        pagination: numberedPaginationSchema.parse(res.body.pagination),
      };
    };

    expect((await listar("")).ids.sort()).toEqual([a, b, c].sort());
    expect((await listar("?q=caf%C3%A9")).ids).toEqual([a]);
    // `%` es literal, no comodín.
    expect((await listar("?q=50%25")).ids).toEqual([a]);
    expect((await listar("?q=coffee")).ids).toEqual([a]);
    expect((await listar("?format=slideshow")).ids).toEqual([b]);
    expect((await listar("?tag=hooks")).ids.sort()).toEqual([a, b].sort());
    expect((await listar("?tag=hooks&format=video")).ids).toEqual([a]);
    expect((await listar("?q=nada-de-esto")).ids).toEqual([]);

    const pag = await listar("?limit=2&page=2");
    expect(pag.ids).toHaveLength(1);
    expect(pag.pagination).toEqual({
      page: 2,
      pageSize: 2,
      totalItems: 3,
      totalPages: 2,
      hasMore: false,
    });

    const tags = await pedir(ws, "GET", "/inspiration/tags");
    expect(tags.body.data).toEqual(["carousel", "copy", "hooks"]);

    const leida = item(await pedir(ws, "GET", `/inspiration/${a}`));
    expect(leida).toMatchObject({ views: 1300000, likes: 106800, format: "video" });
  });
});

describe("404 cross-tenant en las rutas con id", () => {
  it("ajena, inexistente y no-uuid: 404, sin efectos", async () => {
    const a = await nuevoWorkspace();
    const b = await nuevoWorkspace();
    const deB = item(await pedir(b, "POST", "/inspiration", { url: YT, tags: ["b"] })).id;
    queue.reset();

    for (const id of [deB, randomUUID(), "no-es-uuid"]) {
      for (const [method, url, body] of [
        ["GET", `/inspiration/${id}`, undefined],
        ["PATCH", `/inspiration/${id}`, { tags: ["robada"] }],
        ["DELETE", `/inspiration/${id}`, undefined],
        ["POST", `/inspiration/${id}/remix`, {}],
      ] as const) {
        const res = await pedir(a, method, url, body);
        expect(res.status, `${method} ${url}`).toBe(404);
        expect(res.body.error?.code).toBe("not_found");
      }
    }
    // Nada cambió en la de B, y el remix fallido no dejó pedido ni job.
    const [row] =
      await handle.sql`select niches from trending_items where id = ${deB}::uuid`;
    expect(row?.["niches"]).toEqual(["b"]);
    const [n] = await handle.sql`
      select count(*)::int as n from blitz_prompt_requests where company_id = ${a.companyId}::uuid
    `;
    expect(n?.["n"]).toBe(0);
    expect(queue.forQueue(JOB_QUEUES.discoveryRefill)).toHaveLength(0);
  });

  it("PATCH reemplaza las etiquetas y DELETE borra (después, 404)", async () => {
    const ws = await nuevoWorkspace();
    const id = item(await pedir(ws, "POST", "/inspiration", { url: YT, tags: ["a"] })).id;
    const patched = await pedir(ws, "PATCH", `/inspiration/${id}`, {
      tags: ["B", "c", "b"],
    });
    expect(item(patched).tags).toEqual(["b", "c"]);
    expect((await pedir(ws, "DELETE", `/inspiration/${id}`)).status).toBe(204);
    expect((await pedir(ws, "GET", `/inspiration/${id}`)).status).toBe(404);
  });
});

describe("POST /inspiration/:itemId/remix", () => {
  it("es crear-desde-prompt con la referencia: pedido con source_trending_item_id y job en discovery-refill", async () => {
    const ws = await nuevoWorkspace();
    const id = item(await pedir(ws, "POST", "/inspiration", { url: YT })).id;
    await simularLectura(id, { title: "5 errores", format: "slideshow" });
    queue.reset();

    const res = await pedir(ws, "POST", `/inspiration/${id}/remix`, {});
    expect(res.status).toBe(202);
    const { requestId } = generateBlitzAcceptedSchema.parse(res.body.data);

    const [row] = await handle.sql`
      select prompt, content_type, count, status, source_trending_item_id
        from blitz_prompt_requests where id = ${requestId}::uuid
    `;
    expect(row).toEqual({
      prompt: REMIX_DEFAULT_PROMPT,
      // Una referencia de fotos se remixa como slideshow.
      content_type: "slideshow",
      count: 3,
      status: "queued",
      source_trending_item_id: id,
    });
    const jobs = jobsDe(ws, JOB_QUEUES.discoveryRefill);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({
      companyId: ws.companyId,
      promptRequestId: requestId,
    });
    expect(jobs[0]?.options?.transaction).toBeDefined();

    // Y se consulta como cualquier pedido de prompt.
    const estado = await pedir(ws, "GET", `/blitz/generate/${requestId}`);
    expect(estado.status).toBe(200);
  });

  it("la nota, el formato y la cantidad del dueño mandan", async () => {
    const ws = await nuevoWorkspace();
    const id = item(await pedir(ws, "POST", "/inspiration", { url: YT })).id;
    const res = await pedir(ws, "POST", `/inspiration/${id}/remix`, {
      prompt: "  para la promo de invierno ",
      contentType: "green-screen",
      count: 1,
    });
    const { requestId } = generateBlitzAcceptedSchema.parse(res.body.data);
    const [row] = await handle.sql`
      select prompt, content_type, count from blitz_prompt_requests where id = ${requestId}::uuid
    `;
    expect(row).toEqual({
      prompt: "para la promo de invierno",
      content_type: "green-screen",
      count: 1,
    });
  });

  it("al cerrarse el pedido, las piezas salen en la cola con remixSource (Remixed From)", async () => {
    const ws = await nuevoWorkspace();
    const id = item(await pedir(ws, "POST", "/inspiration", { url: YT })).id;
    await simularLectura(id, {
      title: "NASA | LOOP Trailer",
      format: "video",
      views: 3229,
      likes: null,
    });
    const { requestId } = generateBlitzAcceptedSchema.parse(
      (await pedir(ws, "POST", `/inspiration/${id}/remix`, { count: 1 })).body.data,
    );

    // Lo que hace el worker al terminar, con la función real de `db`.
    const { mediaId, url } = await sembrarMedia(ws, "video");
    await withCompany(
      handle.db,
      ws.companyId,
      async (tx) => {
        const scope = { companyId: ws.companyId };
        const locked = await lockPromptRequest(tx, scope, requestId);
        expect(locked).not.toBeNull();
        await completePromptRequest(tx, scope, requestId, [
          {
            contentType: "wall-of-text",
            aiExplanation: "• toma el hook del trailer",
            angleId: null,
            influencerId: null,
            textStylePresetId: null,
            generatedText: "remix",
            buildPlan: {
              version: 1,
              media: { format: "wall-of-text", video: { mediaId, url } },
              texts: ["remix"],
            },
          },
        ]);
      },
      { role: APP_ROLE },
    );

    const [s] = await handle.sql`
      select remix_source_url, source_trending_item_id
        from suggestions where prompt_request_id = ${requestId}::uuid
    `;
    expect(s).toEqual({ remix_source_url: YT, source_trending_item_id: id });

    const cola = blitzQueueSchema.parse(
      (await pedir(ws, "GET", "/blitz/queue")).body.data,
    );
    const remix = cola.find((c) => c.promptRequestId === requestId);
    expect(remix?.remixSource).toEqual({
      url: YT,
      thumbnailUrl: "https://bucket.test/inspiration/thumb.jpg",
      views: 3229,
      // `likes` null en la referencia: ausente, no `0`.
    });
  });
});
