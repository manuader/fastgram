/**
 * Content angles contra Postgres real — PRD §9.4, FR-055, FR-056, §9.10.
 *
 * **El test que justifica este archivo es el del rollback.** §9.4 exige *"crear
 * ángulo **y** reescribir `angleWeights` en la misma transacción"*, y eso es
 * exactamente lo que no se puede probar con un doble en memoria: un fake "transaccional"
 * da por bueno lo que se le pida. La única forma de saber que el `INSERT` se deshace
 * cuando el reconcile falla es hacer fallar el reconcile contra una base que de verdad
 * tenga que revertir.
 *
 * Qué se rompe si el reconcile queda fuera de la transacción: el ángulo sobrevive y
 * `angleWeights` no lo cubre, así que el mapa suma 100 sobre N-1 ángulos. No hay error
 * y no hay alerta — el usuario ve un ángulo que creó y que no sale nunca. Y al revés,
 * un mapa que no suma 100 hace que el `CHECK` de `blitz_preferences` rechace una
 * petición posterior que no tiene nada que ver con ésta.
 *
 * ## Por qué siembra lo suyo en vez de usar `test/helpers/fixtures.ts`
 *
 * `seed()` hace `TRUNCATE ... CASCADE` de diez tablas. Este archivo se escribió con
 * otros agentes trabajando sobre la misma base de `docker compose`, y truncar les
 * borraría los datos en mitad de su corrida. Acá cada corrida crea su propio workspace
 * con ids nuevos y no toca nada de nadie. El precio es no poder comparar contra el
 * workspace `b` de los fixtures, y por eso el 404 cruzado se prueba con un segundo
 * workspace propio.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FastifyInstance } from "fastify";
import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import type { Queue } from "@fastgram/ports";
import {
  APP_ROLE,
  apiKeys,
  blitzPreferencesRepository,
  companies,
  contentAngleRepository,
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

import { DATABASE_URL } from "./helpers/fixtures.js";

interface Workspace {
  readonly companyId: string;
  readonly token: string;
}

let handle: DbHandle;
let app: FastifyInstance;
let ws: Workspace;
let other: Workspace;

async function seedWorkspace(ownerUserId: string, name: string): Promise<Workspace> {
  return withoutCompany(handle.db, async (tx) => {
    const [company] = await tx
      .insert(companies)
      .values({
        name,
        ownerUserId,
        status: "active",
        planId: "growth",
        billingAnchorDay: 1,
        timezone: "UTC",
      })
      .returning({ id: companies.id });
    if (company === undefined) throw new Error("no se creó la company");

    const key = generateApiKey();
    await tx.insert(apiKeys).values({
      companyId: company.id,
      label: `key de ${name}`,
      hash: key.hash,
      kind: "workspace",
    });

    return { companyId: company.id, token: key.token };
  });
}

const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});

/**
 * Cola presente pero inservible.
 *
 * `POST /blitz` exige la dependencia **antes** de tocar nada, porque crear un
 * `Content` en `BUILDING` sin encolar el build lo deja colgado para siempre.
 *
 * Cada método grita si alguien lo llama, y eso sigue siendo correcto para **esta**
 * suite: sus dos casos de `POST /blitz` cortan en 409 (sin perfil) y en 400
 * (`aspectRatio` fuera de slideshow), así que no llegan a mirar la cola.
 *
 * **Pero la ruta ya sí encola**, y conviene saberlo antes de agregar un caso acá: con
 * perfil listo y la cola de sugerencias vacía pide un `discovery-refill` (ver
 * `test/discovery-refill.int.test.ts`). Un caso nuevo que llegue a ese punto va a
 * hacer gritar a este doble — y el grito estaría bien, porque significa que hace falta
 * una cola de verdad y no que el doble sobre.
 */
const unusedQueue: Queue = {
  enqueue: async () => {
    throw new Error("esta suite no debería llegar a encolar");
  },
  enqueueMany: async () => {
    throw new Error("esta suite no debería llegar a encolar");
  },
  work: async () => {
    throw new Error("esta suite no consume trabajos");
  },
  getJob: async () => null,
  cancel: async () => false,
  scheduleRecurring: async () => {
    throw new Error("esta suite no programa trabajos periódicos");
  },
  start: async () => {},
  stop: async () => {},
};

/** Crea un ángulo por la API y devuelve su id. Falla ruidoso si no salió 201. */
async function createAngle(title: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/api/v1/blitz/angles",
    headers: bearer(ws.token),
    payload: { title, description: `descripción de ${title}`, targetAudience: "pymes" },
  });
  expect(response.statusCode).toBe(201);
  return (JSON.parse(response.body) as { data: { _id: string } }).data._id;
}

async function readPreferences(): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: "GET",
    url: "/api/v1/blitz/preferences",
    headers: bearer(ws.token),
  });
  expect(response.statusCode).toBe(200);
  return (JSON.parse(response.body) as { data: Record<string, unknown> }).data;
}

const angleWeightsOf = (prefs: Record<string, unknown>): Record<string, number> =>
  prefs["angleWeights"] as Record<string, number>;

beforeAll(async () => {
  await migrateWithUrl(DATABASE_URL);
  handle = createDb({ url: DATABASE_URL, max: 4, onnotice: () => {} });

  const ownerUserId = await withoutCompany(handle.db, async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        externalIdentityId: `ext-${randomUUID()}`,
        email: `angles-${randomUUID()}@example.test`,
        fullName: "Owner de prueba",
        timezone: "UTC",
      })
      .returning({ id: users.id });
    if (user === undefined) throw new Error("no se creó el user");
    return user.id;
  });

  ws = await seedWorkspace(ownerUserId, `angles-${randomUUID()}`);
  other = await seedWorkspace(ownerUserId, `otros-${randomUUID()}`);

  const clock = new FixedClock("2026-09-21T12:00:00.000Z");
  app = await buildServer({
    deps: {
      db: handle.db,
      clock,
      storage: new MemoryStorage(clock),
      // Límites reales, con el store en memoria. El único que estas rutas cobran es
      // `blitzPreferencesUpdate` (3/min, §9.6) y el archivo hace 2 PATCH por
      // workspace: si alguien agrega un tercero sin mover el reloj, va a ver un 429
      // y no un fallo del reconcile.
      limiter: new TokenBucketLimiter(createMemoryBucketStore(), clock),
      idempotency: new IdempotencyGuard(
        createDbIdempotencyStore({ db: handle.db, appRole: APP_ROLE }),
        clock,
      ),
      // Sin el rol, la conexión de desarrollo es superusuario y saltea RLS.
      appRole: APP_ROLE,
      queue: unusedQueue,
    },
    logLevel: "silent",
    enableAccessLog: false,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await handle?.close();
});

describe("POST /blitz/angles — crear reconcilia en la misma transacción (§9.4)", () => {
  it("el primer ángulo deja el mapa en 100 y crea la fila de preferencias", async () => {
    const id = await createAngle("uno");
    expect(angleWeightsOf(await readPreferences())).toEqual({ [id]: 100 });
  });

  it("con tres ángulos el reparto es 34/33/33, no 33/33/33", async () => {
    const second = await createAngle("dos");
    const third = await createAngle("tres");

    const weights = angleWeightsOf(await readPreferences());
    const values = Object.values(weights).sort((a, b) => b - a);

    // Quién se queda el punto sobrante depende del orden del repositorio y, con dos
    // filas del mismo instante, del desempate por id. El PRD no dice quién debe
    // quedárselo: lo que exige es el reparto par y la suma exacta.
    expect(values).toEqual([34, 33, 33]);
    expect(values.reduce((a, b) => a + b, 0)).toBe(100);
    expect(Object.keys(weights)).toContain(second);
    expect(Object.keys(weights)).toContain(third);
  });
});

describe("un fallo después del INSERT deja la base como estaba", () => {
  it("ni el ángulo ni los pesos sobreviven al rollback", async () => {
    const before = await readPreferences();
    const weightsBefore = angleWeightsOf(before);
    const listBefore = await app.inject({
      method: "GET",
      url: "/api/v1/blitz/angles?limit=100",
      headers: bearer(ws.token),
    });
    const countBefore = (JSON.parse(listBefore.body) as { data: unknown[] }).data.length;

    // El reconcile escribe `angleWeights` con `update` (y cae a `upsert` sólo si no
    // había fila). Hacerlo fallar reproduce exactamente el caso que §9.4 describe:
    // el INSERT del ángulo ya ocurrió y lo que sigue se rompe.
    //
    // El mock **cuenta los ángulos con el mismo executor** antes de tirar. Sin esa
    // cuenta el test no probaría nada: pasaría igual si el INSERT nunca hubiera
    // ocurrido. Con ella queda demostrado que la fila existía dentro de la
    // transacción y que lo que la hizo desaparecer fue el rollback.
    let visibleDuringTx = -1;
    const boom = vi
      .spyOn(blitzPreferencesRepository, "update")
      .mockImplementation(async (exec) => {
        visibleDuringTx = await contentAngleRepository.count(exec, {
          companyId: ws.companyId,
        });
        throw new Error("fallo inyectado después del INSERT");
      });

    try {
      const failed = await app.inject({
        method: "POST",
        url: "/api/v1/blitz/angles",
        headers: bearer(ws.token),
        payload: {
          title: "no debería existir",
          description: "este ángulo tiene que desaparecer con la transacción",
          targetAudience: "nadie",
        },
      });
      expect(failed.statusCode).toBe(500);
    } finally {
      boom.mockRestore();
    }

    const listAfter = await app.inject({
      method: "GET",
      url: "/api/v1/blitz/angles?limit=100",
      headers: bearer(ws.token),
    });
    const rows = (JSON.parse(listAfter.body) as { data: { title: string }[] }).data;

    // 1. El ángulo estaba escrito dentro de la transacción cuando el reconcile falló.
    expect(visibleDuringTx).toBe(countBefore + 1);
    // 2. Y después del fallo no está: lo deshizo el rollback, no la suerte.
    expect(rows).toHaveLength(countBefore);
    expect(rows.map((row) => row.title)).not.toContain("no debería existir");
    expect(angleWeightsOf(await readPreferences())).toEqual(weightsBefore);
  });
});

describe("DELETE /blitz/angles/:id — borrar es desactivar (FR-056, PRD:1319)", () => {
  it("el ángulo sigue listándose con isActive false y los pesos se reparten entre los demás", async () => {
    const victim = await createAngle("a desactivar");

    const deleted = await app.inject({
      method: "DELETE",
      url: `/api/v1/blitz/angles/${victim}`,
      headers: bearer(ws.token),
    });
    expect(deleted.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/blitz/angles?limit=100",
      headers: bearer(ws.token),
    });
    const rows = (JSON.parse(list.body) as { data: { _id: string; isActive: boolean }[] })
      .data;
    const row = rows.find((candidate) => candidate._id === victim);

    // Si fuera un borrado real, el PATCH que el PRD promete para revertirlo no
    // tendría sobre qué correr.
    expect(row).toBeDefined();
    expect(row?.isActive).toBe(false);

    const weights = angleWeightsOf(await readPreferences());
    expect(Object.keys(weights)).not.toContain(victim);
    expect(Object.values(weights).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("reactivar por PATCH lo devuelve al mapa", async () => {
    const list = await app.inject({
      method: "GET",
      url: "/api/v1/blitz/angles?limit=100",
      headers: bearer(ws.token),
    });
    const rows = (JSON.parse(list.body) as { data: { _id: string; isActive: boolean }[] })
      .data;
    const inactive = rows.find((candidate) => !candidate.isActive);
    expect(inactive).toBeDefined();
    const id = inactive?._id ?? "";

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/blitz/angles/${id}`,
      headers: bearer(ws.token),
      payload: { isActive: true },
    });
    expect(patched.statusCode).toBe(200);

    const weights = angleWeightsOf(await readPreferences());
    expect(Object.keys(weights)).toContain(id);
    expect(Object.values(weights).reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe("PATCH /blitz/angles/:id — qué dispara reconcile y qué no", () => {
  it("renombrar NO reconcilia: los pesos personalizados sobreviven a una corrección", async () => {
    const id = await createAngle("con nombre viejo");
    const weightsBefore = angleWeightsOf(await readPreferences());

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/blitz/angles/${id}`,
      headers: bearer(ws.token),
      payload: { title: "con nombre nuevo" },
    });
    expect(patched.statusCode).toBe(200);
    expect((JSON.parse(patched.body) as { data: { title: string } }).data.title).toBe(
      "con nombre nuevo",
    );

    // FR-055: *"Renombrar o editar la descripción **no** dispara reconcile"*.
    expect(angleWeightsOf(await readPreferences())).toEqual(weightsBefore);
  });

  it("un patch de título no reescribe la descripción de la fila", async () => {
    const id = await createAngle("intacta la descripción");
    await app.inject({
      method: "PATCH",
      url: `/api/v1/blitz/angles/${id}`,
      headers: bearer(ws.token),
      payload: { title: "otro título" },
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/blitz/angles?limit=100",
      headers: bearer(ws.token),
    });
    const rows = (
      JSON.parse(list.body) as { data: { _id: string; description: string }[] }
    ).data;
    expect(rows.find((row) => row._id === id)?.description).toBe(
      "descripción de intacta la descripción",
    );
  });
});

describe("PATCH /blitz/preferences", () => {
  it("un patch parcial no pisa los demás campos ni los ángulos reconciliados", async () => {
    const weightsBefore = angleWeightsOf(await readPreferences());

    const patched = await app.inject({
      method: "PATCH",
      url: "/api/v1/blitz/preferences",
      headers: bearer(ws.token),
      payload: { remixPercentage: 80 },
    });
    expect(patched.statusCode).toBe(200);

    const after = (JSON.parse(patched.body) as { data: Record<string, unknown> }).data;
    expect(after["remixPercentage"]).toBe(80);
    // El content mix sigue sumando 100 y en su reparto par: el upsert manda la fila
    // entera justamente para que un patch de un campo no resetee los otros.
    expect(after["slideshowWeight"]).toBe(25);
    expect(angleWeightsOf(after)).toEqual(weightsBefore);
  });

  it("funciona en un workspace que todavía no tiene fila (DATA-006)", async () => {
    const patched = await app.inject({
      method: "PATCH",
      url: "/api/v1/blitz/preferences",
      headers: bearer(other.token),
      payload: { genderFilter: "woman" },
    });
    expect(patched.statusCode).toBe(200);

    const data = (JSON.parse(patched.body) as { data: Record<string, unknown> }).data;
    expect(data["genderFilter"]).toBe("woman");
    expect(data["influencerChance"]).toBe(50);
    expect(data["angleWeights"]).toEqual({});
  });

  it("`angleWeights` que no cubre los ángulos activos es 400", async () => {
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/blitz/preferences",
      headers: bearer(ws.token),
      payload: { angleWeights: { [randomUUID()]: 100 } },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /blitz/angles/page — paginación numerada (§9.10)", () => {
  it("devuelve `Page X of Y` con el envelope de dos claves de §9.3", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/blitz/angles/page?page=1&limit=2",
      headers: bearer(ws.token),
    });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as {
      data: unknown[];
      pagination: Record<string, unknown>;
    };
    expect(Object.keys(body).sort()).toEqual(["data", "pagination"]);
    expect(body.data.length).toBeLessThanOrEqual(2);
    expect(body.pagination["page"]).toBe(1);
    expect(body.pagination["pageSize"]).toBe(2);
    expect(body.pagination).not.toHaveProperty("cursor");
    expect(typeof body.pagination["totalPages"]).toBe("number");
  });

  it("una página vacía es `Page 1 of 1`, no `of 0`", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1/blitz/angles/page",
      headers: bearer(other.token),
    });
    const body = JSON.parse(response.body) as { pagination: Record<string, unknown> };
    expect(body.pagination["totalItems"]).toBe(0);
    expect(body.pagination["totalPages"]).toBe(1);
    expect(body.pagination["hasMore"]).toBe(false);
  });
});

describe("el acceso cruzado es indistinguible de un id inexistente (§9.2)", () => {
  it("PATCH sobre el ángulo de otro workspace da el mismo 404 que un id inventado", async () => {
    const foreign = await createAngle("de este workspace");

    const cross = await app.inject({
      method: "PATCH",
      url: `/api/v1/blitz/angles/${foreign}`,
      headers: bearer(other.token),
      payload: { title: "no" },
    });
    const unknown = await app.inject({
      method: "PATCH",
      url: `/api/v1/blitz/angles/${randomUUID()}`,
      headers: bearer(other.token),
      payload: { title: "no" },
    });

    expect(cross.statusCode).toBe(404);
    expect(cross.body).toBe(unknown.body);
  });

  it("DELETE cruzado tampoco desactiva nada", async () => {
    const mine = await createAngle("intacto");

    const cross = await app.inject({
      method: "DELETE",
      url: `/api/v1/blitz/angles/${mine}`,
      headers: bearer(other.token),
    });
    expect(cross.statusCode).toBe(404);

    const list = await app.inject({
      method: "GET",
      url: "/api/v1/blitz/angles?limit=100",
      headers: bearer(ws.token),
    });
    const rows = (JSON.parse(list.body) as { data: { _id: string; isActive: boolean }[] })
      .data;
    expect(rows.find((row) => row._id === mine)?.isActive).toBe(true);
  });
});

describe("POST /blitz", () => {
  it("sin Company Profile listo responde 409 company_profile_not_ready (PRD:1023)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/blitz",
      headers: bearer(ws.token),
      payload: {},
    });
    expect(response.statusCode).toBe(409);
    expect((JSON.parse(response.body) as { error: { code: string } }).error.code).toBe(
      "company_profile_not_ready",
    );
  });

  it("`aspectRatio` fuera de slideshow es 400 (FR-050 Validation)", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/blitz",
      headers: bearer(ws.token),
      payload: { contentType: "green-screen", aspectRatio: "9:16" },
    });
    expect(response.statusCode).toBe(400);
  });
});
