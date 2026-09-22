/**
 * `POST /blitz` con la cola vacía **pide el relleno** — `FR-050`, `AI-002`,
 * PRD:1117, PRD:1128.
 *
 * ## Qué persigue este archivo
 *
 * Que el mensaje de la respuesta sea cierto. Con la cola vacía, `FR-050` manda
 * responder *«the queue replenishes in the background»*, y hasta que se escribió
 * esto **nada en todo el repo insertaba una fila en `suggestions`**: la frase era
 * una promesa que no cumplía nadie.
 *
 * El catálogo de trabajos declara con `scheduled` los que dispara un reloj, y
 * `discoveryRefill` **no lo tiene**: es por evento. El PRD nombra el evento del
 * onboarding tres veces (PRD:759, 1890, 2006), pero el onboarding todavía no tiene
 * rutas; el otro momento en que el PRD promete el relleno es justamente éste.
 *
 * ## Por qué hay un cubo de tiempo en la clave
 *
 * Sin `singletonKey`, un workspace cuyo relleno falla encola un job por petición, y
 * ésta es una ruta caliente. Pero el adaptador deriva de esa clave un **id
 * determinista y permanente**, así que una clave fija por workspace encolaría el
 * refill **una sola vez en la vida**. El cubo por minuto es lo que hace que se pueda
 * repetir y siga acotado.
 *
 * Este archivo **no hace `TRUNCATE`**: crea su propio workspace y no le pisa la base
 * a las otras suites.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import {
  APP_ROLE,
  apiKeys,
  companies,
  companyProfiles,
  createDb,
  migrateWithUrl,
  users,
  withoutCompany,
  type DbHandle,
} from "@fastgram/db";

import { buildServer } from "../src/server/app.js";
import { generateApiKey } from "../src/auth/api-keys.js";
import { IdempotencyGuard } from "../src/http/idempotency.js";
import { TokenBucketLimiter } from "../src/http/rate-limit.js";
import { createDbIdempotencyStore } from "../src/support/idempotency-store.js";
import { createMemoryBucketStore } from "../src/support/bucket-store.js";
import { RecordingQueue } from "./helpers/harness.js";

const DATABASE_URL =
  process.env["DATABASE_URL"] ?? "postgres://fastgram:fastgram@localhost:5432/fastgram";

const REFILL = "discovery-refill";

let handle: DbHandle;
let app: FastifyInstance;
let queue: RecordingQueue;
let clock: FixedClock;
let companyId: string;
let token: string;

const bearer = (): Record<string, string> => ({ authorization: `Bearer ${token}` });

/** Dispara `POST /blitz`. Con perfil listo y cola vacía, tiene que dar 404. */
async function correrBlitz(): Promise<number> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/blitz",
    headers: bearer(),
    payload: {},
  });
  return response.statusCode;
}

function pedidosDeRelleno(): readonly { companyId: string }[] {
  return queue.enqueued
    .filter((job) => job.queue === REFILL)
    .map((job) => job.payload as { companyId: string });
}

function clavesDeRelleno(): readonly (string | undefined)[] {
  return queue.enqueued
    .filter((job) => job.queue === REFILL)
    .map((job) => job.options?.singletonKey);
}

beforeAll(async () => {
  await migrateWithUrl(DATABASE_URL);
  handle = createDb({ url: DATABASE_URL });
  clock = new FixedClock("2026-09-22T12:00:00.000Z");
  queue = new RecordingQueue();

  const seeded = await withoutCompany(handle.db, async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        // `external_identity_id` es `not null` y no tiene default: es el id del
        // proveedor de identidad, que todavía no existe (`P1-AUTH-001`).
        externalIdentityId: `test_${randomUUID()}`,
        email: `refill-${randomUUID()}@test.local`,
        fullName: "refill",
        timezone: "UTC",
      })
      .returning({ id: users.id });
    if (user === undefined) throw new Error("no se creó el user");

    const [company] = await tx
      .insert(companies)
      .values({
        name: `refill ${randomUUID().slice(0, 8)}`,
        ownerUserId: user.id,
        status: "active",
        planId: "growth",
        billingAnchorDay: 1,
        timezone: "UTC",
      })
      .returning({ id: companies.id });
    if (company === undefined) throw new Error("no se creó la company");

    // `ready` es la precondición de `POST /blitz`: sin esto la ruta corta en 409
    // y nunca llega a mirar la cola.
    await tx
      .insert(companyProfiles)
      .values({ companyId: company.id, status: "ready", coreIdentity: "pymes" });

    const key = generateApiKey();
    await tx.insert(apiKeys).values({
      companyId: company.id,
      label: "refill",
      hash: key.hash,
      kind: "workspace",
    });
    return { companyId: company.id, token: key.token };
  });

  companyId = seeded.companyId;
  token = seeded.token;

  app = await buildServer({
    deps: {
      db: handle.db,
      clock,
      storage: new MemoryStorage(clock),
      limiter: new TokenBucketLimiter(createMemoryBucketStore(), clock),
      idempotency: new IdempotencyGuard(
        createDbIdempotencyStore({ db: handle.db, appRole: APP_ROLE }),
        clock,
      ),
      // Sin el rol, la conexión de desarrollo es superusuaria y saltea RLS.
      appRole: APP_ROLE,
      queue,
    },
  });
  await app.ready();
}, 120_000);

/**
 * **Cada test necesita su propio minuto.**
 *
 * La clave del relleno lleva un cubo de un minuto y el reloj es fijo, así que
 * sin esto el segundo test se deduplica contra el job del primero y ve cero
 * jobs nuevos. Lo descubrí cuando el doble de la cola pasó a honrar
 * `singletonKey` como el adaptador real: hasta entonces registraba todo y la
 * colisión entre tests era invisible.
 */
beforeEach(() => {
  clock.advanceMs(60_000);
});

afterAll(async () => {
  await app?.close();
  await handle?.close();
});

describe("la cola vacía pide su propio relleno", () => {
  it("el 404 de FR-050 viene acompañado de un pedido de relleno", async () => {
    expect(await correrBlitz()).toBe(404);

    expect(pedidosDeRelleno()).toEqual([{ companyId }]);
  });

  it("dos intentos en el mismo minuto son UN job, no dos", async () => {
    // **Esta aserción cambió, y por qué cambió importa.** Antes decía «dos jobs
    // registrados con la misma clave», y eso sólo era verdad porque el doble de
    // la cola registraba todo sin mirar `singletonKey`. O sea que medía la
    // permisividad del doble, no la ruta.
    //
    // El doble ahora deduplica como el adaptador real, así que lo observable es
    // lo que de verdad pasa en producción: la segunda petición **no crea un
    // job**. Es una aserción más fuerte y sobre el comportamiento real.
    const antes = clavesDeRelleno().length;
    await correrBlitz();
    await correrBlitz();

    expect(clavesDeRelleno().slice(antes)).toHaveLength(1);
  });

  it("un minuto después SÍ se crea otro: el relleno se puede volver a pedir", async () => {
    // Con una clave fija por workspace, el adaptador —que deriva de ella un id
    // determinista y permanente— encolaría el refill **una sola vez en la vida**
    // del workspace. El cubo de tiempo es lo que lo hace repetible.
    const antes = clavesDeRelleno().length;
    await correrBlitz();
    clock.advanceMs(60_000);
    await correrBlitz();

    const nuevas = clavesDeRelleno().slice(antes);
    expect(nuevas).toHaveLength(2);
    expect(new Set(nuevas).size).toBe(2);
  });

  it("la clave lleva el workspace, así que dos no se pisan", async () => {
    const claves = clavesDeRelleno();
    expect(claves.every((clave) => clave?.includes(companyId) === true)).toBe(true);
  });
});

describe("pedir el relleno no puede hundir la respuesta", () => {
  it("si la cola falla, el usuario igual recibe su 404 con el mensaje de espera", async () => {
    // Un error de la cola **no cambia lo que es cierto**: la cola está vacía. Si
    // esto devolviera 500, un workspace nuevo con la cola de jobs caída vería un
    // error de servidor en vez del estado de espera que FR-050 define.
    queue.failNext = true;

    const response = await app.inject({
      method: "POST",
      url: "/api/v1/blitz",
      headers: bearer(),
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    const body = JSON.parse(response.body) as {
      error: { code: string; message: string };
    };
    expect(body.error.code).toBe("not_found");
    expect(body.error.message).toContain("replenishes in the background");
  });
});
