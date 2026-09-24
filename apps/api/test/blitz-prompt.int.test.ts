/**
 * Crear desde prompt — `POST /blitz/generate` y `GET /blitz/generate/:requestId`
 * (`PU-BLITZ-003`, `EXT-009`).
 *
 * Lo que persigue este archivo:
 *
 *  - `202 { requestId }`: el pedido queda `queued` y el job encolado **en la
 *    misma transacción**, en `discovery-refill` con `promptRequestId` y una
 *    `singletonKey` que no se repite;
 *  - el estado se lee con el scope del workspace: ajeno, inexistente y no-uuid
 *    son el mismo `404`;
 *  - la validación del body (3–500, 1–5, sin `custom`) y la `Idempotency-Key`
 *    obligatoria, con replay;
 *  - lo que el worker produce va **primero** en `GET /blitz/queue` y es lo que
 *    consume `POST /blitz` sin id (el orden de consumo y el de listado siguen
 *    siendo uno);
 *  - los códigos de fallo del contrato son los de `core`.
 *
 * El worker no corre acá: su parte la mide `apps/worker/test/blitz-prompt.int.test.ts`.
 * Lo que el worker escribe se siembra con SQL, con la misma forma.
 *
 * No hace `TRUNCATE`: crea sus propios workspaces.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import {
  BLITZ_PROMPT_FAILURE_REASONS,
  blitzPromptRequestSchema,
  blitzQueueSchema,
  generateBlitzAcceptedSchema,
} from "@fastgram/contracts";
import { JOB_QUEUES, PROMPT_FAILURE_REASONS } from "@fastgram/core";
import {
  APP_ROLE,
  apiKeys,
  companies,
  companyProfiles,
  createDb,
  media,
  migrateWithUrl,
  suggestions,
  users,
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
        email: `blitzp-${randomUUID()}@test.local`,
        fullName: "blitz prompt",
        timezone: "UTC",
      })
      .returning({ id: users.id });
    if (user === undefined) throw new Error("no se creó el user");
    const [company] = await tx
      .insert(companies)
      .values({
        name: `blitzp ${randomUUID().slice(0, 8)}`,
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
      label: "blitzp",
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
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
}

async function pedir(
  ws: Workspace,
  method: "GET" | "POST",
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

const generar = (ws: Workspace, body: unknown, key: string = randomUUID()) =>
  pedir(ws, "POST", "/blitz/generate", body, key);
const estado = (ws: Workspace, id: string) =>
  pedir(ws, "GET", `/blitz/generate/${encodeURIComponent(id)}`);

function requestIdDe(res: Respuesta): string {
  return generateBlitzAcceptedSchema.parse(res.body.data).requestId;
}

function jobsDePrompt(ws: Workspace) {
  return queue
    .forQueue(JOB_QUEUES.discoveryRefill)
    .filter(
      (j) =>
        (j.payload as { companyId?: string; promptRequestId?: string }).companyId ===
          ws.companyId &&
        (j.payload as { promptRequestId?: string }).promptRequestId !== undefined,
    );
}

/** Lo que el worker escribiría al cerrar un pedido: N filas con `prompt_request_id`. */
async function simularWorker(
  ws: Workspace,
  requestId: string,
  n: number,
): Promise<string[]> {
  const mediaId = randomUUID();
  const url = `https://bucket.test/media/${ws.companyId}/${mediaId}.mp4`;
  return withoutCompany(handle.db, async (tx) => {
    await tx.insert(media).values({
      mediaId,
      companyId: ws.companyId,
      mediaType: "video",
      filename: `${mediaId}.mp4`,
      r2Url: url,
      storageKey: `media/${ws.companyId}/${mediaId}.mp4`,
      status: "ready",
      sizeMb: 1,
      categories: ["background-video"],
      origin: "manual_upload",
    });
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const [row] = await tx
        .insert(suggestions)
        .values({
          companyId: ws.companyId,
          contentType: "wall-of-text",
          generatedText: `prompt ${String(i)}`,
          aiExplanation: "• hook\n\nCreated from your prompt",
          promptRequestId: requestId,
          // Mismo escalón que `completePromptRequest`: la primera, la más nueva.
          createdAt: new Date(Date.parse(NOW) - i),
          buildPlan: {
            version: 1,
            media: { format: "wall-of-text", video: { mediaId, url } },
            texts: [`prompt ${String(i)}`],
          },
        })
        .returning({ id: suggestions.id });
      if (row === undefined) throw new Error("no se sembró");
      ids.push(row.id);
    }
    await handle.sql`
      update blitz_prompt_requests set status = 'done' where id = ${requestId}::uuid
    `;
    return ids;
  });
}

/** Sugerencias «del refill», más nuevas que las del prompt. */
async function sembrarDelRefill(ws: Workspace, n: number): Promise<string[]> {
  const mediaId = randomUUID();
  const url = `https://bucket.test/media/${ws.companyId}/${mediaId}.mp4`;
  return withoutCompany(handle.db, async (tx) => {
    await tx.insert(media).values({
      mediaId,
      companyId: ws.companyId,
      mediaType: "video",
      filename: `${mediaId}.mp4`,
      r2Url: url,
      storageKey: `media/${ws.companyId}/${mediaId}.mp4`,
      status: "ready",
      sizeMb: 1,
      categories: ["background-video"],
      origin: "manual_upload",
    });
    const filas = await tx
      .insert(suggestions)
      .values(
        Array.from({ length: n }, (_, i) => ({
          companyId: ws.companyId,
          contentType: "wall-of-text" as const,
          generatedText: `refill ${String(i)}`,
          aiExplanation: "refill",
          // Una hora DESPUÉS de las del prompt: sin la regla de orden, irían arriba.
          createdAt: new Date(Date.parse(NOW) + 3_600_000),
          buildPlan: {
            version: 1,
            media: { format: "wall-of-text", video: { mediaId, url } },
            texts: [`refill ${String(i)}`],
          },
        })),
      )
      .returning({ id: suggestions.id });
    return filas.map((f) => f.id);
  });
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

describe("POST /blitz/generate", () => {
  it("202 { requestId }: el pedido queda queued y el job, en discovery-refill", async () => {
    const ws = await nuevoWorkspace();
    const res = await generar(ws, {
      prompt: "  hacé un meme sobre los lunes para mi cafetería  ",
      contentType: "green-screen",
      count: 3,
    });
    expect(res.status).toBe(202);
    const requestId = requestIdDe(res);

    const [row] = await handle.sql`
      select prompt, content_type, count, status from blitz_prompt_requests
       where id = ${requestId}::uuid and company_id = ${ws.companyId}::uuid
    `;
    expect(row).toEqual({
      prompt: "hacé un meme sobre los lunes para mi cafetería",
      content_type: "green-screen",
      count: 3,
      status: "queued",
    });

    const jobs = jobsDePrompt(ws);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({
      companyId: ws.companyId,
      promptRequestId: requestId,
    });
    // En la transacción del pedido (ADR-005) y con una clave que no se repite.
    expect(jobs[0]?.options?.transaction).toBeDefined();
    expect(jobs[0]?.options?.singletonKey).toBe(
      `${JOB_QUEUES.discoveryRefill}:prompt:${requestId}`,
    );
  });

  it("sin contentType ni count: lo decide el mix, y es 1", async () => {
    const ws = await nuevoWorkspace();
    const requestId = requestIdDe(await generar(ws, { prompt: "promo de medialunas" }));
    const res = await estado(ws, requestId);
    expect(blitzPromptRequestSchema.parse(res.body.data)).toEqual({
      requestId,
      status: "queued",
      suggestionIds: [],
      count: 1,
    });
  });

  it("dos pedidos iguales con keys distintas son dos pedidos y dos jobs", async () => {
    const ws = await nuevoWorkspace();
    const a = requestIdDe(await generar(ws, { prompt: "lunes" }));
    const b = requestIdDe(await generar(ws, { prompt: "lunes" }));
    expect(a).not.toBe(b);
    expect(jobsDePrompt(ws)).toHaveLength(2);
  });

  it("misma Idempotency-Key y mismo body: replay, un solo pedido y un solo job", async () => {
    const ws = await nuevoWorkspace();
    const key = randomUUID();
    const a = await generar(ws, { prompt: "lunes" }, key);
    const b = await generar(ws, { prompt: "lunes" }, key);
    expect(b.status).toBe(202);
    expect(requestIdDe(b)).toBe(requestIdDe(a));
    expect(jobsDePrompt(ws)).toHaveLength(1);
    const [n] = (await handle.sql`
      select count(*)::int as n from blitz_prompt_requests where company_id = ${ws.companyId}::uuid
    `) as unknown as [{ n: number }];
    expect(n.n).toBe(1);
  });

  it("validación: 400 sin tocar nada", async () => {
    const ws = await nuevoWorkspace();
    const malos: unknown[] = [
      {},
      { prompt: "ab" },
      { prompt: "     " },
      { prompt: "x".repeat(501) },
      { prompt: "lunes", count: 0 },
      { prompt: "lunes", count: 6 },
      { prompt: "lunes", contentType: "custom" },
      { prompt: "lunes", extra: 1 },
    ];
    for (const body of malos) {
      const res = await generar(ws, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(jobsDePrompt(ws)).toHaveLength(0);
  });

  it("sin Idempotency-Key → 400", async () => {
    const ws = await nuevoWorkspace();
    const res = await pedir(ws, "POST", "/blitz/generate", { prompt: "lunes" });
    expect(res.status).toBe(400);
    expect(jobsDePrompt(ws)).toHaveLength(0);
  });

  it("si la cola falla, no queda un pedido huérfano", async () => {
    const ws = await nuevoWorkspace();
    queue.failNext = true;
    const res = await generar(ws, { prompt: "lunes" });
    expect(res.status).toBe(500);
    const [n] = (await handle.sql`
      select count(*)::int as n from blitz_prompt_requests where company_id = ${ws.companyId}::uuid
    `) as unknown as [{ n: number }];
    expect(n.n).toBe(0);
  });
});

describe("GET /blitz/generate/:requestId", () => {
  it("done: las sugerencias en el orden de la cola", async () => {
    const ws = await nuevoWorkspace();
    const requestId = requestIdDe(await generar(ws, { prompt: "lunes", count: 3 }));
    const ids = await simularWorker(ws, requestId, 3);
    const res = await estado(ws, requestId);
    expect(res.status).toBe(200);
    const view = blitzPromptRequestSchema.parse(res.body.data);
    expect(view.status).toBe("done");
    expect(view.suggestionIds).toEqual(ids);
    expect(view.failureReason).toBeUndefined();
  });

  it("failed: el código estable, sin nada crudo", async () => {
    const ws = await nuevoWorkspace();
    const requestId = requestIdDe(
      await generar(ws, { prompt: "lunes", contentType: "slideshow" }),
    );
    await handle.sql`
      update blitz_prompt_requests set status = 'failed', failure_reason = 'no_media_for_format'
       where id = ${requestId}::uuid
    `;
    const view = blitzPromptRequestSchema.parse((await estado(ws, requestId)).body.data);
    expect(view).toMatchObject({
      status: "failed",
      failureReason: "no_media_for_format",
      contentType: "slideshow",
    });
  });

  it("un failure_reason que no es un código estable no sale", async () => {
    const ws = await nuevoWorkspace();
    const requestId = requestIdDe(await generar(ws, { prompt: "lunes" }));
    await handle.sql`
      update blitz_prompt_requests set status = 'failed',
             failure_reason = 'ECONNREFUSED 127.0.0.1:11434'
       where id = ${requestId}::uuid
    `;
    const res = await estado(ws, requestId);
    expect(res.status).toBe(200);
    expect(blitzPromptRequestSchema.parse(res.body.data).failureReason).toBeUndefined();
  });

  it("ajeno, inexistente y no-uuid → el mismo 404", async () => {
    const a = await nuevoWorkspace();
    const b = await nuevoWorkspace();
    const deA = requestIdDe(await generar(a, { prompt: "lunes" }));

    const ajeno = await estado(b, deA);
    const inexistente = await estado(b, randomUUID());
    const malformado = await estado(b, "no-es-un-uuid");
    for (const r of [ajeno, inexistente, malformado]) {
      expect(r.status).toBe(404);
      expect(r.body.error?.code).toBe("not_found");
    }
    expect(ajeno.body).toEqual(inexistente.body);
    // Y el de A sigue siendo de A.
    expect((await estado(a, deA)).status).toBe(200);
  });
});

describe("las del prompt van primeras, y son las que se consumen", () => {
  it("GET /blitz/queue: primero las del prompt (con promptRequestId), después el refill", async () => {
    const ws = await nuevoWorkspace();
    const requestId = requestIdDe(await generar(ws, { prompt: "lunes", count: 2 }));
    const delPrompt = await simularWorker(ws, requestId, 2);
    const delRefill = await sembrarDelRefill(ws, 2);

    const res = await pedir(ws, "GET", "/blitz/queue");
    const cola = blitzQueueSchema.parse(res.body.data);
    expect(cola.map((s) => s.id)).toEqual([
      ...delPrompt,
      ...cola.slice(2).map((s) => s.id),
    ]);
    expect(
      cola
        .slice(2)
        .map((s) => s.id)
        .sort(),
    ).toEqual([...delRefill].sort());
    expect(cola.slice(0, 2).every((s) => s.promptRequestId === requestId)).toBe(true);
    expect(cola.slice(2).every((s) => s.promptRequestId === undefined)).toBe(true);
  });

  it("POST /blitz sin id consume la primera del prompt: listado y consumo, un solo orden", async () => {
    const ws = await nuevoWorkspace();
    const requestId = requestIdDe(await generar(ws, { prompt: "lunes", count: 2 }));
    const delPrompt = await simularWorker(ws, requestId, 2);
    await sembrarDelRefill(ws, 2);

    const antes = blitzQueueSchema.parse(
      (await pedir(ws, "GET", "/blitz/queue")).body.data,
    );
    expect(antes[0]?.id).toBe(delPrompt[0]);

    const res = await pedir(ws, "POST", "/blitz", {});
    expect(res.status).toBe(202);
    const builds = queue
      .forQueue(JOB_QUEUES.contentBuild)
      .map((j) => j.payload as { companyId?: string; suggestionId?: string })
      .filter((p) => p.companyId === ws.companyId);
    expect(builds.map((b) => b.suggestionId)).toEqual([delPrompt[0]]);

    const despues = blitzQueueSchema.parse(
      (await pedir(ws, "GET", "/blitz/queue")).body.data,
    );
    expect(despues[0]?.id).toBe(delPrompt[1]);
  });
});

describe("contrato ↔ core", () => {
  it("los códigos de fallo del contrato son exactamente los de core", () => {
    expect([...BLITZ_PROMPT_FAILURE_REASONS]).toEqual([...PROMPT_FAILURE_REASONS]);
  });
});

describe("sprint 7 — buscar el meme si no hay", () => {
  it("running con phase searching_meme: el estado la dice; cerrado, no", async () => {
    const ws = await nuevoWorkspace();
    const requestId = requestIdDe(
      await generar(ws, { prompt: "lunes", contentType: "green-screen" }),
    );
    await handle.sql`
      update blitz_prompt_requests set status = 'running', phase = 'searching_meme',
             meme_searches = 1
       where id = ${requestId}::uuid
    `;
    const running = blitzPromptRequestSchema.parse(
      (await estado(ws, requestId)).body.data,
    );
    expect(running.phase).toBe("searching_meme");

    await handle.sql`
      update blitz_prompt_requests set status = 'failed', failure_reason = 'meme_not_found'
       where id = ${requestId}::uuid
    `;
    const failed = blitzPromptRequestSchema.parse(
      (await estado(ws, requestId)).body.data,
    );
    expect(failed.phase).toBeUndefined();
    expect(failed.failureReason).toBe("meme_not_found");
  });

  it("la base hace cumplir el tope de 2 búsquedas por pedido", async () => {
    const ws = await nuevoWorkspace();
    const requestId = requestIdDe(await generar(ws, { prompt: "lunes" }));
    await expect(
      handle.sql`update blitz_prompt_requests set meme_searches = 3 where id = ${requestId}::uuid`,
    ).rejects.toThrow(/meme_searches_range/);
  });

  it("GET /blitz/queue: la anotación del build_plan sale como autoFoundMeme", async () => {
    const ws = await nuevoWorkspace();
    const requestId = requestIdDe(await generar(ws, { prompt: "lunes", count: 1 }));
    const [id] = await simularWorker(ws, requestId, 1);
    await handle.sql`
      update suggestions
         set build_plan = build_plan || ${JSON.stringify({
           autoFoundMeme: {
             mediaId: "x",
             sourceUrl: "https://www.youtube.com/watch?v=J3bvkPStwB8",
           },
         })}::jsonb
       where id = ${id!}::uuid
    `;
    const cola = blitzQueueSchema.parse(
      (await pedir(ws, "GET", "/blitz/queue")).body.data,
    );
    expect(cola.find((s) => s.id === id)?.autoFoundMeme).toEqual({
      sourceUrl: "https://www.youtube.com/watch?v=J3bvkPStwB8",
    });
    expect(
      cola.filter((s) => s.id !== id).every((s) => s.autoFoundMeme === undefined),
    ).toBe(true);
  });
});
