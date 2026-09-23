/**
 * `POST /blitz` acepta una sugerencia y **cobra** — `FR-050`, `P2-BLITZ-014`,
 * PRD §16.2, §2.4 (2026-09-23), §9.6.
 *
 * Lo que persigue este archivo no es "devuelve 202". Es la contabilidad:
 *
 *  - un 202 descuenta **exactamente** 1 save y 1 swipe, y deja escrito de qué
 *    bucket y período salió el save (sin eso el reembolso del worker no puede
 *    devolverlo);
 *  - un rechazo por cuota **no consume nada** — ni el swipe, que el gate de saves
 *    va antes (§16.2), ni la sugerencia, ni la pieza;
 *  - el reintento con la misma `Idempotency-Key` no cobra dos veces;
 *  - dos aceptaciones simultáneas sobre la última unidad de cuota cobran **una**.
 *
 * El último es el que puede pasar por la razón equivocada (trampa 22): sin forzar
 * el solapamiento, las dos peticiones se ordenan solas y el test pasa con el lock y
 * sin él. Por eso una transacción ajena **retiene la fila del ledger** hasta que
 * `pg_stat_activity` muestra a las dos bloqueadas por ella, y recién ahí la suelta.
 *
 * Como `discovery-refill.int.test.ts`, este archivo **no hace `TRUNCATE`**: crea sus
 * propios workspaces y no le pisa la base a otras suites.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import { contentBuildPayloadSchema } from "@fastgram/contracts";
import { JOB_QUEUES, PLANS, billingPeriodKey } from "@fastgram/core";
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

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgres://fastgram:fastgram@localhost:5432/fastgram";

const NOW = "2026-09-23T12:00:00.000Z";
/** Ancla 1: el período en curso empieza el 1 de septiembre. */
const PERIOD = billingPeriodKey(new Date(NOW), 1);
const NEXT_BILLING_RESET = Date.parse("2026-10-01T00:00:00.000Z");
const NEXT_DAILY_RESET = new Date("2026-09-24T00:00:00.000Z");
const GROWTH_LIMIT = PLANS.growth.contentSaves ?? 0;

let handle: DbHandle;
let app: FastifyInstance;
let queue: RecordingQueue;

interface Workspace {
  readonly companyId: string;
  readonly token: string;
}

type Plan = "free" | "starter" | "growth" | "pro";
type SubscriptionStatus = "trialing" | "active";

async function nuevoWorkspace(
  opts: {
    plan?: Plan;
    subscriptionStatus?: SubscriptionStatus;
    profile?: "ready" | "pending";
  } = {},
): Promise<Workspace> {
  return withoutCompany(handle.db, async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        externalIdentityId: `test_${randomUUID()}`,
        email: `blitz-${randomUUID()}@test.local`,
        fullName: "blitz",
        timezone: "UTC",
      })
      .returning({ id: users.id });
    if (user === undefined) throw new Error("no se creó el user");

    const [company] = await tx
      .insert(companies)
      .values({
        name: `blitz ${randomUUID().slice(0, 8)}`,
        ownerUserId: user.id,
        status: "active",
        planId: opts.plan ?? "growth",
        subscriptionStatus: opts.subscriptionStatus ?? "active",
        billingAnchorDay: 1,
        timezone: "UTC",
      })
      .returning({ id: companies.id });
    if (company === undefined) throw new Error("no se creó la company");

    await tx.insert(companyProfiles).values({
      companyId: company.id,
      status: opts.profile ?? "ready",
      coreIdentity: "pymes",
    });

    const key = generateApiKey();
    await tx.insert(apiKeys).values({
      companyId: company.id,
      label: "blitz",
      hash: key.hash,
      kind: "workspace",
    });
    return { companyId: company.id, token: key.token };
  });
}

/** Un asset `ready` del Media Bank del workspace. Devuelve su id y su URL. */
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
 * `n` sugerencias `queued` **construibles**: con el `build_plan` que escribe el
 * refill (migración `0011`) sobre un `background-video` real del workspace.
 * Devuelve sus ids.
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

/** Una sugerencia de antes de la migración `0011`: sin `build_plan`. */
async function encolarVieja(ws: Workspace): Promise<string> {
  return withoutCompany(handle.db, async (tx) => {
    const [fila] = await tx
      .insert(suggestions)
      .values({
        companyId: ws.companyId,
        contentType: "wall-of-text" as const,
        generatedText: "vieja",
        aiExplanation: "vieja",
      })
      .returning({ id: suggestions.id });
    if (fila === undefined) throw new Error("no se creó la sugerencia");
    return fila.id;
  });
}

interface LedgerRow {
  content_saves_used: number;
  content_saves_purchased: number;
  overage_units: number;
  daily_swipes_used: number;
  /**
   * Texto, no `Date`: `drizzle()` le cambia los parsers al cliente postgres.js
   * que comparte (trampa 18), así que un `timestamptz` crudo vuelve como string.
   */
  daily_swipe_reset_at: string | null;
}

/** El instante de reset guardado, en ISO, sin depender del formato del driver. */
const resetIso = (l: LedgerRow | null): string | null =>
  l?.daily_swipe_reset_at == null ? null : new Date(l.daily_swipe_reset_at).toISOString();

/** El ledger del período, leído directo: el test mira la contabilidad. */
async function ledger(ws: Workspace): Promise<LedgerRow | null> {
  const filas = await handle.sql`
    select content_saves_used, content_saves_purchased, overage_units,
           daily_swipes_used, daily_swipe_reset_at
    from quota_ledgers
    where company_id = ${ws.companyId}::uuid and period = ${PERIOD}
  `;
  return (filas[0] as unknown as LedgerRow | undefined) ?? null;
}

/** Deja el ledger del período con los valores dados, creándolo si no existe. */
async function fijarLedger(
  ws: Workspace,
  valores: {
    used?: number;
    purchased?: number;
    swipes?: number;
    swipeResetAt?: Date | null;
  },
): Promise<void> {
  await handle.sql`
    insert into quota_ledgers (
      company_id, period, content_saves_included, content_saves_used,
      content_saves_purchased, daily_swipes_used, daily_swipe_reset_at
    ) values (
      ${ws.companyId}::uuid, ${PERIOD}, ${GROWTH_LIMIT}, ${valores.used ?? 0},
      ${valores.purchased ?? 0}, ${valores.swipes ?? 0},
      ${valores.swipeResetAt === undefined || valores.swipeResetAt === null ? null : valores.swipeResetAt.toISOString()}::timestamptz
    )
    on conflict (company_id, period) do update set
      content_saves_used = excluded.content_saves_used,
      content_saves_purchased = excluded.content_saves_purchased,
      daily_swipes_used = excluded.daily_swipes_used,
      daily_swipe_reset_at = excluded.daily_swipe_reset_at
  `;
}

async function estadoSugerencia(id: string): Promise<string | undefined> {
  const filas = await handle.sql`select status from suggestions where id = ${id}::uuid`;
  return (filas[0] as { status: string } | undefined)?.status;
}

async function piezas(ws: Workspace): Promise<
  {
    id: string;
    status: string;
    type: string;
    save_bucket: string | null;
    save_period: string | null;
  }[]
> {
  const filas = await handle.sql`
    select id, status, type, save_bucket, save_period
    from contents where company_id = ${ws.companyId}::uuid
  `;
  return filas as never;
}

interface Respuesta {
  status: number;
  body: {
    data?: Record<string, unknown>;
    error?: { code: string; message: string; details?: Record<string, unknown> };
  };
}

async function aceptar(
  ws: Workspace,
  opts: { key?: string; body?: Record<string, unknown> } = {},
): Promise<Respuesta> {
  const res = await app.inject({
    method: "POST",
    url: "/api/v1/blitz",
    headers: {
      authorization: `Bearer ${ws.token}`,
      "content-type": "application/json",
      ...(opts.key === undefined ? {} : { "idempotency-key": opts.key }),
    },
    payload: JSON.stringify(opts.body ?? {}),
  });
  return { status: res.statusCode, body: JSON.parse(res.body) as Respuesta["body"] };
}

function jobsDeBuild(ws: Workspace): Record<string, unknown>[] {
  return queue
    .forQueue(JOB_QUEUES.contentBuild)
    .map((j) => j.payload as Record<string, unknown>)
    .filter((p) => p["companyId"] === ws.companyId);
}

beforeAll(async () => {
  await migrateWithUrl(DATABASE_URL);
  // Pool holgado: la carrera necesita a la vez la transacción que retiene el lock,
  // las dos peticiones y la conexión que consulta `pg_stat_activity`.
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
      // Sin el rol, la conexión de desarrollo es superusuaria y saltea RLS.
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

describe("aceptar cobra 1 save + 1 swipe, crea la pieza y encola el build", () => {
  it("202 con la pieza en BUILDING, y el ledger sube uno en cada contador", async () => {
    const ws = await nuevoWorkspace();
    const [sugerencia] = await encolar(ws, 1);

    const res = await aceptar(ws);

    expect(res.status).toBe(202);
    expect(res.body.data?.["status"]).toBe("BUILDING");
    expect(res.body.data?.["type"]).toBe("wall-of-text");

    const l = await ledger(ws);
    expect(l?.content_saves_used).toBe(1);
    expect(l?.daily_swipes_used).toBe(1);
    // El próximo 00:00 UTC, escrito junto con el contador (§16.2).
    expect(resetIso(l)).toBe(NEXT_DAILY_RESET.toISOString());

    expect(await estadoSugerencia(sugerencia as string)).toBe("popped");
  });

  it("la pieza guarda bucket y período: es lo que usa el reembolso del worker", async () => {
    const ws = await nuevoWorkspace();
    await encolar(ws, 1);

    const res = await aceptar(ws);
    const [pieza] = await piezas(ws);

    expect(pieza?.id).toBe(res.body.data?.["_id"]);
    expect(pieza?.save_bucket).toBe("included");
    expect(pieza?.save_period).toBe(PERIOD);
  });

  it("encola content-build con la pieza, la revisión y la procedencia blitz", async () => {
    const ws = await nuevoWorkspace();
    const [sugerencia] = await encolar(ws, 1);

    const res = await aceptar(ws);

    expect(jobsDeBuild(ws)).toEqual([
      expect.objectContaining({
        contentId: res.body.data?.["_id"],
        contentType: "wall-of-text",
        revision: 1,
        reason: "blitz",
        suggestionId: sugerencia,
      }),
    ]);
    // ADR-005: dentro de la transacción de la ruta, no aparte.
    const job = queue.forQueue(JOB_QUEUES.contentBuild)[0];
    expect(job?.options?.transaction).toBeDefined();
  });

  it("con saldo comprado y el cupo agotado, el save sale de `purchased`", async () => {
    const ws = await nuevoWorkspace();
    await encolar(ws, 1);
    await fijarLedger(ws, { used: GROWTH_LIMIT, purchased: 2 });

    expect((await aceptar(ws)).status).toBe(202);

    const l = await ledger(ws);
    expect(l?.content_saves_used).toBe(GROWTH_LIMIT);
    expect(l?.content_saves_purchased).toBe(1);
    expect((await piezas(ws))[0]?.save_bucket).toBe("purchased");
  });
});

describe("swipes: se cuentan y no se limitan (PRD §2.4, 2026-09-23)", () => {
  it("con 10 000 swipes hoy, igual acepta y cuenta el siguiente", async () => {
    const ws = await nuevoWorkspace();
    await encolar(ws, 1);
    await fijarLedger(ws, { swipes: 10_000, swipeResetAt: NEXT_DAILY_RESET });

    expect((await aceptar(ws)).status).toBe(202);
    expect((await ledger(ws))?.daily_swipes_used).toBe(10_001);
  });

  it("con el reset diario vencido, el contador arranca de nuevo aunque el cron no haya corrido", async () => {
    const ws = await nuevoWorkspace();
    await encolar(ws, 1);
    await fijarLedger(ws, {
      swipes: 7,
      swipeResetAt: new Date("2026-09-23T00:00:00.000Z"),
    });

    expect((await aceptar(ws)).status).toBe(202);
    const l = await ledger(ws);
    expect(l?.daily_swipes_used).toBe(1);
    expect(resetIso(l)).toBe(NEXT_DAILY_RESET.toISOString());
  });
});

describe("sin saves: 429 content_quota_exceeded, y no se consume nada", () => {
  it("responde el código, el copy y los detalles de ERR-R03", async () => {
    const ws = await nuevoWorkspace();
    await encolar(ws, 1);
    await fijarLedger(ws, { used: GROWTH_LIMIT });

    const res = await aceptar(ws);

    expect(res.status).toBe(429);
    expect(res.body.error?.code).toBe("content_quota_exceeded");
    expect(res.body.error?.message).toBe("Monthly content quota reached for your plan");
    // `resetAt` en ms de epoch: lo que tipa el contrato y lo que lee la web.
    expect(res.body.error?.details).toEqual({
      count: GROWTH_LIMIT,
      limit: GROWTH_LIMIT,
      resetAt: NEXT_BILLING_RESET,
    });
  });

  it("ni el swipe, ni el save, ni la sugerencia, ni la pieza, ni el job", async () => {
    // §16.2 / PRD:1858: "un `content_quota_exceeded` no consume swipe ni save
    // adicional". El swipe es el que se pierde si el orden de los gates se da
    // vuelta, y no se recupera hasta mañana.
    const ws = await nuevoWorkspace();
    const [sugerencia] = await encolar(ws, 1);
    await fijarLedger(ws, {
      used: GROWTH_LIMIT,
      swipes: 3,
      swipeResetAt: NEXT_DAILY_RESET,
    });

    expect((await aceptar(ws)).status).toBe(429);

    const l = await ledger(ws);
    expect(l?.content_saves_used).toBe(GROWTH_LIMIT);
    expect(l?.daily_swipes_used).toBe(3);
    expect(await estadoSugerencia(sugerencia as string)).toBe("queued");
    expect(await piezas(ws)).toHaveLength(0);
    expect(jobsDeBuild(ws)).toHaveLength(0);
  });
});

describe("Free (+ trialing): el límite no se puede comprobar → 503, no 429", () => {
  it("responde service_unavailable con quotaExhausted: false y no escribe nada", async () => {
    // El primer workspace nace Free + trialing (§2.4). Su cupo es el trial
    // allowance de por vida, y §16.1 no da el número. Un 429 diría que se agotó
    // algo que nadie midió; un 202 regalaría la pieza.
    const ws = await nuevoWorkspace({ plan: "free", subscriptionStatus: "trialing" });
    const [sugerencia] = await encolar(ws, 1);

    const res = await aceptar(ws);

    expect(res.status).toBe(503);
    expect(res.body.error?.code).toBe("service_unavailable");
    expect(res.body.error?.details).toEqual({ quotaExhausted: false });
    // El `lockPeriod` había creado la fila del período; la transacción volvió
    // atrás entera, así que tampoco queda eso.
    expect(await ledger(ws)).toBeNull();
    expect(await estadoSugerencia(sugerencia as string)).toBe("queued");
    expect(await piezas(ws)).toHaveLength(0);
    expect(jobsDeBuild(ws)).toHaveLength(0);
  });
});

describe("Idempotency-Key (opcional; FR-050, NFR-004)", () => {
  it("el reintento con la misma key devuelve la misma pieza y no cobra dos veces", async () => {
    const ws = await nuevoWorkspace();
    const [primeraSugerencia, segundaSugerencia] = await encolar(ws, 2);
    const key = `blitz-${randomUUID()}`;

    const primera = await aceptar(ws, { key });
    const segunda = await aceptar(ws, { key });

    expect(primera.status).toBe(202);
    expect(segunda.status).toBe(202);
    expect(segunda.body.data?.["_id"]).toBe(primera.body.data?.["_id"]);

    const l = await ledger(ws);
    expect(l?.content_saves_used).toBe(1);
    expect(l?.daily_swipes_used).toBe(1);
    expect(await piezas(ws)).toHaveLength(1);
    expect(jobsDeBuild(ws)).toHaveLength(1);
    // La segunda sugerencia sigue en la cola: el replay no sacó otra.
    const estados = [
      await estadoSugerencia(primeraSugerencia as string),
      await estadoSugerencia(segundaSugerencia as string),
    ].sort();
    expect(estados).toEqual(["popped", "queued"]);
  });

  it("sin key, dos peticiones son dos aceptaciones: por eso el cliente no reintenta solo", async () => {
    const ws = await nuevoWorkspace();
    await encolar(ws, 2);

    expect((await aceptar(ws)).status).toBe(202);
    expect((await aceptar(ws)).status).toBe(202);
    expect((await ledger(ws))?.content_saves_used).toBe(2);
  });

  it("un 429 de cuota libera la key: al volver a haber cupo, la misma key acepta", async () => {
    // §9.3 regla 3: "una petición que falla libera la key". Un rechazo
    // determinista no puede quemarla.
    const ws = await nuevoWorkspace();
    await encolar(ws, 1);
    await fijarLedger(ws, { used: GROWTH_LIMIT });
    const key = `blitz-${randomUUID()}`;

    expect((await aceptar(ws, { key })).status).toBe(429);

    await fijarLedger(ws, { used: 0 });
    const reintento = await aceptar(ws, { key });
    expect(reintento.status).toBe(202);
    expect((await ledger(ws))?.content_saves_used).toBe(1);
  });
});

describe("cross-tenant", () => {
  it("la cola de otro workspace no se toca: 404 de cola vacía, y lo ajeno queda igual", async () => {
    const a = await nuevoWorkspace();
    const b = await nuevoWorkspace();
    const [deB] = await encolar(b, 1);

    const res = await aceptar(a);

    expect(res.status).toBe(404);
    expect(res.body.error?.code).toBe("not_found");
    expect(res.body.error?.message).toContain("replenishes in the background");
    expect(await estadoSugerencia(deB as string)).toBe("queued");
    expect(await ledger(b)).toBeNull();
    expect(await piezas(b)).toHaveLength(0);
    // Y a `a` no se le cobró nada por una cola vacía.
    expect(await ledger(a)).toBeNull();
  });

  it("aceptar en A cobra en A y en ningún otro lado", async () => {
    const a = await nuevoWorkspace();
    const b = await nuevoWorkspace();
    await encolar(a, 1);
    const [deB] = await encolar(b, 1);

    expect((await aceptar(a)).status).toBe(202);

    expect((await ledger(a))?.content_saves_used).toBe(1);
    expect(await ledger(b)).toBeNull();
    expect(await estadoSugerencia(deB as string)).toBe("queued");
  });
});

describe("perfil no listo", () => {
  it("409 company_profile_not_ready sin consumir nada", async () => {
    const ws = await nuevoWorkspace({ profile: "pending" });
    const [sugerencia] = await encolar(ws, 1);

    const res = await aceptar(ws);

    expect(res.status).toBe(409);
    expect(res.body.error?.code).toBe("company_profile_not_ready");
    expect(await ledger(ws)).toBeNull();
    expect(await estadoSugerencia(sugerencia as string)).toBe("queued");
  });
});

describe("carrera: dos aceptaciones sobre la última unidad de cuota", () => {
  /**
   * Cuántos backends esperan, directa o indirectamente, **al retenedor**.
   *
   * Se filtra por quién bloquea y no por el texto de la consulta: la base es
   * compartida, y otra suite corriendo a la vez podría tener sus propias esperas
   * sobre `quota_ledgers`. Contarlas soltaría el lock antes de que las dos
   * peticiones de acá estén esperando, y el test pasaría sin medir la carrera.
   *
   * "Indirectamente" porque así hace cola Postgres sobre una fila: la primera
   * espera al retenedor y la segunda espera a la primera (el lock de tupla), así
   * que `pg_blocking_pids` de la segunda nombra a la primera, no al retenedor.
   * Contar sólo el primer nivel no llega nunca a 2 — medido: se quedaba en 1.
   */
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

  it("sólo una cobra; la otra recibe 429 y no deja nada", async () => {
    const ws = await nuevoWorkspace();
    // Dos sugerencias: cada petición saca la suya, así que lo que compiten es el
    // ledger y nada más.
    const ids = await encolar(ws, 2);
    await fijarLedger(ws, { used: GROWTH_LIMIT - 1 });

    let dos = false;
    const resultados = await handle.sql.begin(async (retenedor) => {
      // La fila ya existe: no hay conflicto de inserción que serialice a las dos
      // (trampa 22). Lo único que las puede ordenar es el `FOR UPDATE`.
      await retenedor`
        select 1 from quota_ledgers
        where company_id = ${ws.companyId}::uuid and period = ${PERIOD}
        for update
      `;
      const [{ pid }] =
        (await retenedor`select pg_backend_pid()::int as pid`) as unknown as [
          { pid: number },
        ];

      const enVuelo = [aceptar(ws), aceptar(ws)];

      // Hasta que las DOS estén esperando al retenedor. Con el `FOR UPDATE` de
      // `lockPeriod` esperan al leer el ledger; sin él, esperan al escribir los
      // contadores — y ya leyeron el mismo saldo, que es la carrera.
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
    // El `begin` confirmó: el lock se soltó recién ahora.
    const respuestas = await Promise.all(resultados.enVuelo);

    expect(dos).toBe(true);
    expect(respuestas.map((r) => r.status).sort()).toEqual([202, 429]);

    const l = await ledger(ws);
    expect(l?.content_saves_used).toBe(GROWTH_LIMIT);
    expect(l?.daily_swipes_used).toBe(1);
    expect(await piezas(ws)).toHaveLength(1);
    expect(jobsDeBuild(ws)).toHaveLength(1);
    const estados = (await Promise.all(ids.map(estadoSugerencia))).sort();
    expect(estados).toEqual(["popped", "queued"]);
  });
  it("con UNA sugerencia y cupo de sobra, sólo una la saca: la otra ve la cola vacía", async () => {
    // Lo que se mide acá es el `FOR UPDATE` sobre la sugerencia. Sin él, las dos
    // leen la misma fila `queued`, las dos esperan al ledger, y la segunda llega
    // a `markSuggestionPopped` sobre una fila ya `popped`: la guarda del `UPDATE`
    // la frena (trampa 37), pero como un 500 y después de haber hecho todo el
    // trabajo. Con el lock, la segunda ni la toma.
    const ws = await nuevoWorkspace();
    const [unica] = await encolar(ws, 1);
    await fijarLedger(ws, { used: 0 });

    const resultados = await handle.sql.begin(async (retenedor) => {
      await retenedor`
        select 1 from quota_ledgers
        where company_id = ${ws.companyId}::uuid and period = ${PERIOD}
        for update
      `;
      const [{ pid }] =
        (await retenedor`select pg_backend_pid()::int as pid`) as unknown as [
          { pid: number },
        ];

      let terminadas = 0;
      const enVuelo = [aceptar(ws), aceptar(ws)].map((p) =>
        p.finally(() => {
          terminadas += 1;
        }),
      );

      // Con el lock, una espera al ledger y la otra ya volvió (cola vacía). Sin
      // él, las dos esperan al ledger. Cualquiera de los dos estados alcanza para
      // soltar: lo que se afirma después es el resultado.
      const limite = Date.now() + 10_000;
      while (Date.now() < limite) {
        const n = await bloqueadosPor(pid);
        if (n >= 2 || (n >= 1 && terminadas >= 1)) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      return { enVuelo };
    });
    const respuestas = await Promise.all(resultados.enVuelo);

    expect(respuestas.map((r) => r.status).sort()).toEqual([202, 404]);
    expect((await ledger(ws))?.content_saves_used).toBe(1);
    expect(await piezas(ws)).toHaveLength(1);
    expect(await estadoSugerencia(unica as string)).toBe("popped");
  });
});

describe("el buildPayload sale de la sugerencia (AI-002, FR-070)", () => {
  async function payloadDe(contentId: unknown): Promise<unknown> {
    const filas = await handle.sql`
      select build_payload from contents where id = ${String(contentId)}::uuid
    `;
    return (filas[0] as { build_payload: unknown } | undefined)?.build_payload;
  }

  it("la pieza guarda un buildPayload que pasa el schema del worker, sin audio", async () => {
    const ws = await nuevoWorkspace();
    await encolar(ws, 1);

    const res = await aceptar(ws);

    expect(res.status).toBe(202);
    const payload = await payloadDe(res.body.data?.["_id"]);
    // `contentBuildPayloadSchema` es el que usa `toRenderJob` en el worker.
    expect(contentBuildPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({
      canvas: { width: 1080, height: 1920 },
      text: { content: "copy 0" },
    });
    expect(payload).not.toHaveProperty("audio");
    // DATA-008: nunca sale por la API.
    expect(res.body.data).not.toHaveProperty("buildPayload");
  });

  it("slideshow: el canvas sale del aspectRatio de la petición", async () => {
    const ws = await nuevoWorkspace();
    const a = await seedMedia(ws, "image", ["slideshow-image"]);
    const b = await seedMedia(ws, "image", ["slideshow-image"]);
    await withoutCompany(handle.db, async (tx) => {
      await tx.insert(suggestions).values({
        companyId: ws.companyId,
        contentType: "slideshow",
        generatedText: "uno\n\ndos",
        aiExplanation: "x",
        textStylePresetId: "yellow-pop",
        buildPlan: {
          version: 1,
          media: { format: "slideshow", slides: [a, b] },
          texts: ["uno", "dos"],
        },
      });
    });

    const res = await aceptar(ws, { body: { aspectRatio: "1:1" } });

    expect(res.status).toBe(202);
    const payload = await payloadDe(res.body.data?.["_id"]);
    expect(contentBuildPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload).toMatchObject({
      num_images: 2,
      images: [
        {
          canvas: { width: 1080, height: 1080, aspectRatio: "1:1" },
          image: { url: a.url },
          texts: [{ content: "uno", color: "#FFD600" }],
        },
        { image: { url: b.url }, texts: [{ content: "dos" }] },
      ],
    });
  });

  it("una sugerencia vieja sin build_plan: 422, no cobra, se descarta y la siguiente sí se acepta", async () => {
    const ws = await nuevoWorkspace();
    await encolar(ws, 1);
    // La cola sale por `created_at desc`: la vieja, insertada después, sale primero.
    const vieja = await encolarVieja(ws);

    const res = await aceptar(ws);

    // Lo negativo primero (trampa 35): nada cobrado, nada creado, nada encolado.
    expect(await ledger(ws)).toBeNull();
    expect(await piezas(ws)).toEqual([]);
    expect(jobsDeBuild(ws)).toEqual([]);
    expect(res.status).toBe(422);
    expect(res.body.error?.code).toBe("content_unavailable_for_type");
    expect(res.body.error?.details).toMatchObject({
      reason: "missing_build_plan",
      suggestionId: vieja,
      discarded: true,
    });
    expect(await estadoSugerencia(vieja)).toBe("discarded");
    // La cola perdió una: se pide relleno.
    expect(
      queue
        .forQueue(JOB_QUEUES.discoveryRefill)
        .some((j) => (j.payload as { companyId?: string }).companyId === ws.companyId),
    ).toBe(true);

    const otra = await aceptar(ws);
    expect(otra.status).toBe(202);
    expect(await ledger(ws)).toMatchObject({
      content_saves_used: 1,
      daily_swipes_used: 1,
    });
  });

  it("si la media se borró después de planificar: 422 media_unavailable y no cobra", async () => {
    const ws = await nuevoWorkspace();
    const [id] = await encolar(ws, 1);
    await handle.sql`
      update media set deleted_at = now() where company_id = ${ws.companyId}::uuid
    `;

    const res = await aceptar(ws);

    expect(await ledger(ws)).toBeNull();
    expect(await piezas(ws)).toEqual([]);
    expect(res.status).toBe(422);
    expect(res.body.error?.details).toMatchObject({ reason: "media_unavailable" });
    expect(await estadoSugerencia(id as string)).toBe("discarded");
  });

  it("usa la URL de hoy de la media, no la copiada al planificar", async () => {
    const ws = await nuevoWorkspace();
    await encolar(ws, 1);
    const nueva = `https://bucket.test/media/${ws.companyId}/renombrado.mp4`;
    await handle.sql`
      update media set r2_url = ${nueva} where company_id = ${ws.companyId}::uuid
    `;

    const res = await aceptar(ws);

    expect(res.status).toBe(202);
    expect(await payloadDe(res.body.data?.["_id"])).toMatchObject({
      video: { url: nueva },
    });
  });
});
