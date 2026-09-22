/**
 * Aislamiento por tenant — PRD §9.2, P1-API-007.
 *
 * **Éste es el test que más importa de la API.** §9.2 no pide sólo que el acceso
 * cruzado falle: pide que falle de una forma **indistinguible** de un id que no existe.
 *
 * La diferencia es toda la garantía. Si un recurso ajeno devolviera `403` —o `404` con
 * otro mensaje, u otro header, o tardara distinto— la API se convierte en un oráculo de
 * existencia: quien sondea aprende qué ids son reales en workspaces que no son suyos.
 * Por eso los tests no comparan "ambos dan 404": comparan **status y cuerpo completos,
 * byte a byte**, entre el id ajeno y un uuid inventado.
 *
 * Corre contra el Postgres de `docker compose`, con migraciones y RLS aplicados de
 * verdad, y con `SET LOCAL ROLE fastgram_app` — sin el rol, la conexión de desarrollo
 * es superusuario, saltea RLS, y este archivo estaría midiendo sólo los repositorios.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";

import { APP_ROLE } from "@fastgram/db";

import { bearer, type Seed } from "./helpers/fixtures.js";
import { startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;
let app: FastifyInstance;
let data: Seed;
let handle: ApiHarness["handle"];

beforeAll(async () => {
  // El montaje vive en `helpers/harness.ts`: migra, siembra los dos workspaces,
  // monta `MemoryStorage` y una cola que anota, y —lo que hace que esta suite
  // signifique algo— pone `appRole`, sin el cual la conexión de desarrollo es
  // superusuario, saltea RLS, y el archivo mediría sólo los repositorios.
  api = await startApi();
  app = api.app;
  data = api.data;
  handle = api.handle;
}, 180_000);

afterAll(async () => {
  await api?.close();
});

/** Los recursos que exponen `GET /:id`, con el id de cada workspace. */
const resources = [
  { name: "content", path: "/api/v1/content", key: "contentId" },
  { name: "media", path: "/api/v1/media", key: "mediaId" },
  { name: "influencers", path: "/api/v1/influencers", key: "influencerId" },
  { name: "posts", path: "/api/v1/posts", key: "postId" },
] as const;

describe("el acceso cruzado es indistinguible de un id inexistente (§9.2)", () => {
  for (const resource of resources) {
    it(`${resource.name}: el id de B con la key de A da exactamente el mismo 404 que un id inventado`, async () => {
      const foreignId = data.b[resource.key];
      const unknownId = data.unknownId;

      const crossTenant = await app.inject({
        method: "GET",
        url: `${resource.path}/${foreignId}`,
        headers: bearer(data.a.token),
      });

      const nonExistent = await app.inject({
        method: "GET",
        url: `${resource.path}/${unknownId}`,
        headers: bearer(data.a.token),
      });

      // 404 y no 403: el 403 confirma que el id existe.
      expect(crossTenant.statusCode).toBe(404);
      expect(nonExistent.statusCode).toBe(404);

      // Y el cuerpo es el MISMO. Acá es donde se rompería un `not found: content
      // abc-123` bien intencionado que incluyera el id, o un mensaje distinto por
      // rama. No se comparan campos sueltos: se compara el cuerpo entero.
      expect(crossTenant.body).toBe(nonExistent.body);
      expect(JSON.parse(crossTenant.body)).toEqual({
        error: { code: "not_found", message: expect.any(String) },
      });
    });

    it(`${resource.name}: A sí ve lo suyo (el test anterior no pasa por dar 404 siempre)`, async () => {
      // Sin esta comprobación, un handler que devolviera 404 a todo pasaría el test
      // de arriba con honores.
      const own = await app.inject({
        method: "GET",
        url: `${resource.path}/${data.a[resource.key]}`,
        headers: bearer(data.a.token),
      });
      expect(own.statusCode).toBe(200);
      expect(JSON.parse(own.body).data).toBeDefined();
    });
  }

  it("una ruta inexistente usa el mismo envelope y código que un recurso no visible", async () => {
    // Ojo con qué se exige acá. §9.2 pide que un recurso **ajeno** sea
    // indistinguible de un **id** inexistente — eso lo cubren los tests de arriba.
    // Que una RUTA inexistente tenga otro mensaje no filtra nada de otro tenant: no
    // habla de ningún recurso. Lo que sí importa es que el cuerpo tenga la misma
    // forma y el mismo código, para que un cliente parsee los 404 de una sola manera.
    const noRoute = await app.inject({
      method: "GET",
      url: "/api/v1/no-existe-esta-ruta",
      headers: bearer(data.a.token),
    });
    expect(noRoute.statusCode).toBe(404);
    expect(JSON.parse(noRoute.body)).toEqual({
      error: { code: "not_found", message: expect.any(String) },
    });
  });
});

describe("los listados sólo traen lo del propio workspace", () => {
  it("GET /content de A no incluye el content de B", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/content",
      headers: bearer(data.a.token),
    });
    expect(res.statusCode).toBe(200);
    const ids = JSON.parse(res.body).data.map((c: { _id: string }) => c._id);
    expect(ids).toContain(data.a.contentId);
    expect(ids).not.toContain(data.b.contentId);
  });

  it("GET /media de B no incluye el media de A", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/media",
      headers: bearer(data.b.token),
    });
    const ids = JSON.parse(res.body).data.map((m: { mediaId: string }) => m.mediaId);
    expect(ids).toContain(data.b.mediaId);
    expect(ids).not.toContain(data.a.mediaId);
  });

  it("GET /blitz/angles de A no incluye el ángulo de B", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/blitz/angles",
      headers: bearer(data.a.token),
    });
    const ids = JSON.parse(res.body).data.map((a: { _id: string }) => a._id);
    expect(ids).toContain(data.a.angleId);
    expect(ids).not.toContain(data.b.angleId);
  });
});

describe("el borrado idempotente de media no revela existencia (§9.2)", () => {
  it("borrar el media de B desde A devuelve 204, igual que borrar un id inventado", async () => {
    const foreign = await app.inject({
      method: "DELETE",
      url: `/api/v1/media/${data.b.mediaId}`,
      headers: bearer(data.a.token),
    });
    const unknown = await app.inject({
      method: "DELETE",
      url: `/api/v1/media/${data.unknownId}`,
      headers: bearer(data.a.token),
    });

    expect(foreign.statusCode).toBe(204);
    expect(unknown.statusCode).toBe(204);
    expect(foreign.body).toBe(unknown.body);
  });

  it("y el media de B sigue vivo: el 204 fue un no-op de verdad", async () => {
    // El riesgo real de "devolver 204 siempre" es que además borre. Esto lo descarta.
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/media/${data.b.mediaId}`,
      headers: bearer(data.b.token),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe("autenticación (FR-180, PRD:1861-1872)", () => {
  it("sin header: 401 con WWW-Authenticate", async () => {
    const res = await app.inject({ method: "GET", url: "/api/v1/content" });
    expect(res.statusCode).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Bearer realm="api"');
  });

  it("una key revocada falla en el acto", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/content",
      headers: bearer(data.revokedToken),
    });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: { code: "unauthorized", message: "Invalid or revoked API key" },
    });
  });

  it("una key de un workspace soft-deleted da 401, no 404", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/v1/content",
      headers: bearer(data.softDeletedWorkspaceToken),
    });
    expect(res.statusCode).toBe(401);
  });

  it("todas las causas de 401 dan el MISMO cuerpo", async () => {
    // Si la revocada dijera algo distinto de la inexistente, quien sondea aprende
    // que esa key existió alguna vez.
    const bodies = new Set<string>();
    for (const header of [
      bearer(data.revokedToken),
      bearer(`fsln_live_${"z".repeat(32)}`),
      bearer(data.softDeletedWorkspaceToken),
      { authorization: "Basic dXNlcjpwYXNz" },
      { authorization: "Bearer no-es-una-key" },
    ]) {
      const res = await app.inject({
        method: "GET",
        url: "/api/v1/content",
        headers: header,
      });
      expect(res.statusCode).toBe(401);
      expect(res.headers["www-authenticate"]).toBe('Bearer realm="api"');
      bodies.add(res.body);
    }
    expect(bodies.size).toBe(1);
  });

  it("el token en claro no está en la base: sólo su hash", async () => {
    const rows = await handle.sql<{ hash: string }[]>`select hash from api_keys`;
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.hash).not.toContain("fsln_live_");
      expect(row.hash).not.toBe(data.a.token);
      expect(row.hash).not.toBe(data.b.token);
    }
  });
});

describe("RLS: la segunda capa existe de verdad (IMPL §2.4 capa 1)", () => {
  // Los tests de arriba pasan por los repositorios, que ya filtran por `companyId`.
  // Estos van directo a SQL **sin** filtro de tenant: si RLS no estuviera aplicándose,
  // devolverían la fila ajena y nadie se enteraría hasta que alguien escriba una query
  // a mano en producción. Es la capa que cubre justamente ese caso.

  it("con el scope de B, un SELECT sin WHERE de tenant no ve el content de A", async () => {
    await handle.sql.begin(async (sql) => {
      // Sin `SET LOCAL ROLE` esto correría como superusuario, que saltea RLS
      // incondicionalmente: el test daría verde sin probar nada.
      await sql`set local role ${sql.unsafe(APP_ROLE)}`;
      await sql`select set_config('app.current_company', ${data.b.companyId}, true)`;

      const rows = await sql`select id from contents where id = ${data.a.contentId}`;
      expect(rows).toHaveLength(0);

      // Y lo propio sí se ve: descarta que la política esté bloqueando todo.
      const own = await sql`select id from contents where id = ${data.b.contentId}`;
      expect(own).toHaveLength(1);
    });
  });

  it("sin GUC de company no se ve NADA: falla cerrado", async () => {
    await handle.sql.begin(async (sql) => {
      await sql`set local role ${sql.unsafe(APP_ROLE)}`;
      // A propósito: no se setea `app.current_company`. La función devuelve NULL,
      // `company_id = NULL` no es TRUE, y ninguna fila pasa la política.
      const rows = await sql`select id from contents`;
      expect(rows).toHaveLength(0);
    });
  });
});

describe("health", () => {
  it("responde sin autenticación y fuera de /api/v1", async () => {
    // `P1-OBS-004`: el cuerpo dejó de ser `{status:"ok", service:"api"}` a secas.
    // Lo que este archivo tiene que seguir midiendo es lo suyo —que la ruta no
    // pide credencial y no está bajo `/api/v1`—; qué comprueba y qué puede
    // fallar lo mide `health.int.test.ts`.
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ status: "ok", service: "api" });
  });

  it("`/health/live` tampoco pide credencial", async () => {
    const res = await app.inject({ method: "GET", url: "/health/live" });
    expect(res.statusCode).toBe(200);
  });
});
