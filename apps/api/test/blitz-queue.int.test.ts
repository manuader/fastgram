/**
 * La cola de Blitz, vista y decidida por tarjeta — `PU-BLITZ-002`, FR-050.
 *
 * `GET /blitz/queue`, `POST /blitz/queue/:id/discard` y `POST /blitz` con
 * `suggestionId`. Lo que persigue este archivo:
 *
 *  - la cola se **muestra en el mismo orden en que se consume**: la tarjeta de
 *    arriba del deck es la que saldría con un `POST /blitz` a ciegas;
 *  - aceptar por id construye **esa**, aunque haya una más nueva delante;
 *  - ver y descartar **no cobran** (ni save, ni swipe, ni pieza);
 *  - descartar y aceptar el mismo id a la vez: gana uno, el otro recibe `409`.
 *
 * La carrera se fuerza como en `blitz-accept.int.test.ts` (trampa 22): una
 * transacción ajena retiene la fila de la sugerencia hasta que
 * `pg_stat_activity` muestra a las dos peticiones esperándola.
 *
 * No hace `TRUNCATE`: crea sus propios workspaces.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import { blitzQueueSchema } from "@fastgram/contracts";
import { JOB_QUEUES } from "@fastgram/core";
import {
  APP_ROLE,
  apiKeys,
  companies,
  companyProfiles,
  contentAngles,
  createDb,
  influencers,
  media,
  migrateWithUrl,
  suggestions,
  trendingItems,
  users,
  withoutCompany,
  type DbHandle,
} from "@fastgram/db";

import { buildServer } from "../src/server/app.js";
import { generateApiKey } from "../src/auth/api-keys.js";
import { IdempotencyGuard } from "../src/http/idempotency.js";
import { createDbIdempotencyStore } from "../src/support/idempotency-store.js";
import { RecordingQueue, openLimiter } from "./helpers/harness.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgres://fastgram:fastgram@localhost:5432/fastgram";

const NOW = "2026-09-23T12:00:00.000Z";

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
        email: `blitzq-${randomUUID()}@test.local`,
        fullName: "blitz queue",
        timezone: "UTC",
      })
      .returning({ id: users.id });
    if (user === undefined) throw new Error("no se creó el user");
    const [company] = await tx
      .insert(companies)
      .values({
        name: `blitzq ${randomUUID().slice(0, 8)}`,
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
      coreIdentity: "pymes",
    });
    const key = generateApiKey();
    await tx.insert(apiKeys).values({
      companyId: company.id,
      label: "blitzq",
      hash: key.hash,
      kind: "workspace",
    });
    return { companyId: company.id, token: key.token };
  });
}

async function seedMedia(
  ws: Workspace,
  type: "image" | "video",
  categories: string[],
): Promise<{ mediaId: string; url: string }> {
  const mediaId = randomUUID();
  const ext = type === "image" ? "png" : "mp4";
  const url = `https://bucket.test/media/${ws.companyId}/${mediaId}.${ext}`;
  await withoutCompany(handle.db, async (tx) => {
    await tx.insert(media).values({
      mediaId,
      companyId: ws.companyId,
      mediaType: type,
      filename: `${mediaId}.${ext}`,
      r2Url: url,
      storageKey: `media/${ws.companyId}/${mediaId}.${ext}`,
      status: "ready",
      sizeMb: 1,
      categories,
      origin: "manual_upload",
    });
  });
  return { mediaId, url };
}

/**
 * `n` sugerencias construibles **en una sola sentencia**: comparten el `now()`
 * de la transacción, así que el orden entre ellas lo decide el desempate por id.
 * Es a propósito: es lo que hace un refill real.
 */
async function encolar(ws: Workspace, n: number): Promise<string[]> {
  const video = await seedMedia(ws, "video", ["background-video"]);
  return withoutCompany(handle.db, async (tx) => {
    const filas = await tx
      .insert(suggestions)
      .values(
        Array.from({ length: n }, (_, i) => ({
          companyId: ws.companyId,
          contentType: "wall-of-text" as const,
          generatedText: `copy ${String(i)}`,
          aiExplanation: "porque sí",
          buildPlan: {
            version: 1,
            media: { format: "wall-of-text", video },
            texts: [`copy ${String(i)}`],
          },
        })),
      )
      .returning({ id: suggestions.id });
    return filas.map((f) => f.id);
  });
}

async function estadoSugerencia(id: string): Promise<string | undefined> {
  const filas = await handle.sql`select status from suggestions where id = ${id}::uuid`;
  return (filas[0] as { status: string } | undefined)?.status;
}

/** Lo que se cobró: filas de ledger y piezas del workspace. */
async function cobrado(ws: Workspace): Promise<{ ledgers: number; piezas: number }> {
  const [l] = (await handle.sql`
    select count(*)::int as n from quota_ledgers where company_id = ${ws.companyId}::uuid
  `) as unknown as [{ n: number }];
  const [c] = (await handle.sql`
    select count(*)::int as n from contents where company_id = ${ws.companyId}::uuid
  `) as unknown as [{ n: number }];
  return { ledgers: l.n, piezas: c.n };
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
  body?: Record<string, unknown>,
): Promise<Respuesta> {
  const res = await app.inject({
    method,
    url: `/api/v1${url}`,
    headers: {
      authorization: `Bearer ${ws.token}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
  return {
    status: res.statusCode,
    body: res.body === "" ? {} : (JSON.parse(res.body) as Respuesta["body"]),
  };
}

const verCola = (ws: Workspace) => pedir(ws, "GET", "/blitz/queue");
const descartar = (ws: Workspace, id: string) =>
  pedir(ws, "POST", `/blitz/queue/${encodeURIComponent(id)}/discard`);
const aceptar = (ws: Workspace, body: Record<string, unknown> = {}) =>
  pedir(ws, "POST", "/blitz", body);

function idsDe(res: Respuesta): string[] {
  return blitzQueueSchema.parse((res.body as { data: unknown }).data).map((s) => s.id);
}

/** La sugerencia que construyó el último `content-build` de este workspace. */
function jobsDeBuild(ws: Workspace): { suggestionId?: string }[] {
  return queue
    .forQueue(JOB_QUEUES.contentBuild)
    .map((j) => j.payload as { companyId?: string; suggestionId?: string })
    .filter((p) => p.companyId === ws.companyId);
}

function pidioRelleno(ws: Workspace): boolean {
  return queue
    .forQueue(JOB_QUEUES.discoveryRefill)
    .some((j) => (j.payload as { companyId?: string }).companyId === ws.companyId);
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

describe("GET /blitz/queue", () => {
  it("lista en el mismo orden en que POST /blitz consume", async () => {
    const ws = await nuevoWorkspace();
    // Tres con el mismo `created_at` (desempate por id) y una después.
    await encolar(ws, 3);
    await encolar(ws, 1);

    const vista = idsDe(await verCola(ws));
    expect(vista).toHaveLength(4);

    const consumidas: (string | undefined)[] = [];
    for (let i = 0; i < vista.length; i += 1) {
      const res = await aceptar(ws);
      expect(res.status).toBe(202);
      consumidas.push(jobsDeBuild(ws).at(-1)?.suggestionId);
    }
    expect(consumidas).toEqual(vista);
    expect(idsDe(await verCola(ws))).toEqual([]);
  });

  it("no cobra nada y no cambia la cola", async () => {
    const ws = await nuevoWorkspace();
    const ids = await encolar(ws, 2);

    const res = await verCola(ws);

    expect(res.status).toBe(200);
    expect(await cobrado(ws)).toEqual({ ledgers: 0, piezas: 0 });
    expect(jobsDeBuild(ws)).toEqual([]);
    for (const id of ids) expect(await estadoSugerencia(id)).toBe("queued");
  });

  it("con menos de 5 pide relleno; con 5 o más, no", async () => {
    const corta = await nuevoWorkspace();
    await encolar(corta, 4);
    const llena = await nuevoWorkspace();
    await encolar(llena, 5);

    await verCola(corta);
    await verCola(llena);

    expect(pidioRelleno(corta)).toBe(true);
    expect(pidioRelleno(llena)).toBe(false);
  });

  it("dos GET seguidos con la cola corta no crean dos jobs de relleno (singletonKey por minuto)", async () => {
    const ws = await nuevoWorkspace();
    await verCola(ws);
    await verCola(ws);

    const jobs = queue
      .forQueue(JOB_QUEUES.discoveryRefill)
      .filter((j) => (j.payload as { companyId?: string }).companyId === ws.companyId);
    expect(jobs).toHaveLength(1);
  });

  it("sólo las del workspace, sólo las queued", async () => {
    const a = await nuevoWorkspace();
    const b = await nuevoWorkspace();
    const [deA, descartadaA] = await encolar(a, 2);
    await encolar(b, 1);
    expect((await descartar(a, descartadaA as string)).status).toBe(204);

    expect(idsDe(await verCola(a))).toEqual([deA]);
  });

  it("arma la tarjeta: influencer, ángulo, remix con sus números y la preview con la URL de hoy", async () => {
    const ws = await nuevoWorkspace();
    const a = await seedMedia(ws, "image", ["slideshow-image"]);
    const b = await seedMedia(ws, "image", ["slideshow-image"]);
    const hoy = `https://bucket.test/media/${ws.companyId}/renombrada.png`;
    await handle.sql`update media set r2_url = ${hoy} where media_id = ${a.mediaId}::uuid`;

    const ids = await withoutCompany(handle.db, async (tx) => {
      const [inf] = await tx
        .insert(influencers)
        .values({
          companyId: ws.companyId,
          name: "Ana",
          gender: "female",
          age: 28,
          ethnicity: "latina",
        })
        .returning({ id: influencers.id });
      const [angle] = await tx
        .insert(contentAngles)
        .values({ companyId: ws.companyId, title: "Ahorro" })
        .returning({ id: contentAngles.id });
      const [trend] = await tx
        .insert(trendingItems)
        .values({
          platform: "tiktok",
          permalink: "https://www.tiktok.com/@x/video/1",
          thumbnailUrl: "https://cdn.test/thumb.jpg",
          likes: 106_800,
          views: 1_300_000,
        })
        .returning({ id: trendingItems.id });
      const [s] = await tx
        .insert(suggestions)
        .values({
          companyId: ws.companyId,
          contentType: "slideshow",
          generatedText: "uno\n\ndos",
          aiExplanation: "- engancha\n- corto",
          influencerId: inf?.id,
          angleId: angle?.id,
          sourceTrendingItemId: trend?.id,
          buildPlan: {
            version: 1,
            media: { format: "slideshow", slides: [a, b] },
            texts: ["uno", "dos"],
          },
        })
        .returning({ id: suggestions.id });
      return { inf: inf?.id, angle: angle?.id, s: s?.id };
    });

    const res = await verCola(ws);
    const [tarjeta] = blitzQueueSchema.parse((res.body as { data: unknown }).data);

    expect(tarjeta).toEqual({
      id: ids.s,
      contentType: "slideshow",
      generatedText: "uno\n\ndos",
      aiExplanation: "- engancha\n- corto",
      influencer: { id: ids.inf, name: "Ana" },
      angle: { id: ids.angle, title: "Ahorro" },
      remixSource: {
        url: "https://www.tiktok.com/@x/video/1",
        thumbnailUrl: "https://cdn.test/thumb.jpg",
        likes: 106_800,
        views: 1_300_000,
      },
      preview: {
        slides: [
          { imageUrl: hoy, text: "uno" },
          { imageUrl: b.url, text: "dos" },
        ],
      },
    });
    // DATA-008: el plan interno nunca sale.
    expect(JSON.stringify(res.body)).not.toContain("buildPlan");
  });

  it("video: la preview es el fondo; una media borrada no aparece y una vieja sin plan no trae preview", async () => {
    const ws = await nuevoWorkspace();
    const [conFondo] = await encolar(ws, 1);
    const vieja = await withoutCompany(handle.db, async (tx) => {
      const [f] = await tx
        .insert(suggestions)
        .values({
          companyId: ws.companyId,
          contentType: "wall-of-text",
          generatedText: "v",
        })
        .returning({ id: suggestions.id });
      return f?.id;
    });

    const antes = blitzQueueSchema.parse(
      ((await verCola(ws)).body as { data: unknown }).data,
    );
    const fondo = antes.find((s) => s.id === conFondo);
    expect(fondo?.preview?.backgroundUrl).toMatch(/^https:\/\/bucket\.test\/.+\.mp4$/);
    expect(antes.find((s) => s.id === vieja)).toEqual({
      id: vieja,
      contentType: "wall-of-text",
      generatedText: "v",
    });

    await handle.sql`update media set deleted_at = now() where company_id = ${ws.companyId}::uuid`;
    const despues = blitzQueueSchema.parse(
      ((await verCola(ws)).body as { data: unknown }).data,
    );
    const sinFondo = despues.find((s) => s.id === conFondo);
    expect(sinFondo).toBeDefined();
    expect(sinFondo).not.toHaveProperty("preview");
  });
});

describe("POST /blitz/queue/:id/discard", () => {
  it("204: la pasa a discarded, no cobra y pide relleno", async () => {
    const ws = await nuevoWorkspace();
    const [id] = await encolar(ws, 1);

    const res = await descartar(ws, id as string);

    expect(res.status).toBe(204);
    expect(await estadoSugerencia(id as string)).toBe("discarded");
    expect(await cobrado(ws)).toEqual({ ledgers: 0, piezas: 0 });
    expect(jobsDeBuild(ws)).toEqual([]);
    expect(pidioRelleno(ws)).toBe(true);
  });

  it("dos veces la misma → la segunda 409 conflict", async () => {
    const ws = await nuevoWorkspace();
    const [id] = await encolar(ws, 1);
    expect((await descartar(ws, id as string)).status).toBe(204);

    const otra = await descartar(ws, id as string);

    expect(otra.status).toBe(409);
    expect(otra.body.error?.code).toBe("conflict");
  });

  it("una ya aceptada → 409, y sigue popped", async () => {
    const ws = await nuevoWorkspace();
    const [id] = await encolar(ws, 1);
    expect((await aceptar(ws, { suggestionId: id })).status).toBe(202);

    const res = await descartar(ws, id as string);

    expect(res.status).toBe(409);
    expect(await estadoSugerencia(id as string)).toBe("popped");
  });

  it("inexistente, ajena y no-uuid → el mismo 404, sin tocar la ajena", async () => {
    const a = await nuevoWorkspace();
    const b = await nuevoWorkspace();
    const [deB] = await encolar(b, 1);

    const inexistente = await descartar(a, randomUUID());
    const ajena = await descartar(a, deB as string);
    const basura = await descartar(a, "no-soy-un-uuid");

    for (const r of [inexistente, ajena, basura]) {
      expect(r.status).toBe(404);
      expect(r.body.error?.code).toBe("not_found");
    }
    expect(ajena.body).toEqual(inexistente.body);
    expect(await estadoSugerencia(deB as string)).toBe("queued");
  });
});

describe("POST /blitz con suggestionId", () => {
  it("construye esa y no la más nueva", async () => {
    const ws = await nuevoWorkspace();
    const [vieja] = await encolar(ws, 1);
    const [nueva] = await encolar(ws, 1);
    // Precondición: sin id saldría la nueva.
    expect(idsDe(await verCola(ws))[0]).toBe(nueva);

    const res = await aceptar(ws, { suggestionId: vieja });

    expect(res.status).toBe(202);
    expect(jobsDeBuild(ws).map((j) => j.suggestionId)).toEqual([vieja]);
    expect(await estadoSugerencia(vieja as string)).toBe("popped");
    expect(await estadoSugerencia(nueva as string)).toBe("queued");
    expect(await cobrado(ws)).toMatchObject({ piezas: 1 });
  });

  it("una ya descartada → 409 conflict sin cobrar", async () => {
    const ws = await nuevoWorkspace();
    const [id, otra] = await encolar(ws, 2);
    expect((await descartar(ws, id as string)).status).toBe(204);

    const res = await aceptar(ws, { suggestionId: id });

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("conflict");
    expect(await cobrado(ws)).toEqual({ ledgers: 0, piezas: 0 });
    // No cae a "la siguiente": la otra sigue en cola.
    expect(await estadoSugerencia(otra as string)).toBe("queued");
  });

  it("ajena, inexistente o no-uuid → 404 sin cobrar", async () => {
    const a = await nuevoWorkspace();
    const b = await nuevoWorkspace();
    await encolar(a, 1);
    const [deB] = await encolar(b, 1);

    for (const suggestionId of [deB, randomUUID(), "no-soy-un-uuid"]) {
      const res = await aceptar(a, { suggestionId });
      expect(res.status).toBe(404);
      expect(res.body.error?.code).toBe("not_found");
    }
    expect(await cobrado(a)).toEqual({ ledgers: 0, piezas: 0 });
    expect(await estadoSugerencia(deB as string)).toBe("queued");
  });

  it("con un contentType que no es el de la sugerencia → 409 sin cobrar", async () => {
    const ws = await nuevoWorkspace();
    const [id] = await encolar(ws, 1);

    const res = await aceptar(ws, { suggestionId: id, contentType: "slideshow" });

    expect(res.status).toBe(409);
    expect(await cobrado(ws)).toEqual({ ledgers: 0, piezas: 0 });
    expect(await estadoSugerencia(id as string)).toBe("queued");
  });
});

describe("carrera: descartar y aceptar el mismo id a la vez", () => {
  /** Cuántos backends esperan, directa o indirectamente, al retenedor. */
  async function bloqueadosPor(pid: number): Promise<number> {
    const filas = await handle.sql`
      select count(*)::int as n from pg_stat_activity a
      where ${pid}::int = any(pg_blocking_pids(a.pid))
         or exists (
              select 1 from pg_stat_activity b
              where b.pid = any(pg_blocking_pids(a.pid))
                and ${pid}::int = any(pg_blocking_pids(b.pid))
            )
    `;
    return (filas[0] as { n: number }).n;
  }

  it("uno gana y el otro recibe 409; el estado final es el del ganador", async () => {
    const ws = await nuevoWorkspace();
    const [id] = await encolar(ws, 1);

    let dos = false;
    const { enVuelo } = await handle.sql.begin(async (retenedor) => {
      await retenedor`select 1 from suggestions where id = ${id as string}::uuid for update`;
      const [{ pid }] =
        (await retenedor`select pg_backend_pid()::int as pid`) as unknown as [
          { pid: number },
        ];

      const enVuelo = [
        aceptar(ws, { suggestionId: id }).then((r) => ({ op: "accept", ...r })),
        descartar(ws, id as string).then((r) => ({ op: "discard", ...r })),
      ];

      const limite = Date.now() + 10_000;
      while (Date.now() < limite) {
        if ((await bloqueadosPor(pid)) >= 2) {
          dos = true;
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      return { enVuelo };
    });
    const respuestas = await Promise.all(enVuelo);

    expect(dos).toBe(true);
    const ganadoras = respuestas.filter((r) => r.status === 202 || r.status === 204);
    const perdedoras = respuestas.filter((r) => r.status === 409);
    expect(ganadoras).toHaveLength(1);
    expect(perdedoras).toHaveLength(1);
    expect(perdedoras[0]?.body.error?.code).toBe("conflict");

    if (ganadoras[0]?.op === "accept") {
      expect(await estadoSugerencia(id as string)).toBe("popped");
      expect(await cobrado(ws)).toMatchObject({ piezas: 1 });
    } else {
      expect(await estadoSugerencia(id as string)).toBe("discarded");
      expect(await cobrado(ws)).toEqual({ ledgers: 0, piezas: 0 });
    }
  });
});
