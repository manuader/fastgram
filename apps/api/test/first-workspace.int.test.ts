/**
 * `POST /api/v1/onboarding/workspace` — `P1-TENANT-001`.
 *
 * Contra Postgres real, con **Better Auth real** (`createTestIdentity`) y con el
 * rol de la app (`appRole` del arnés): la sesión sale de un signup de verdad, no
 * de un doble, y RLS se aplica.
 *
 * Lo que tiene que ser cierto:
 *
 *  - signup → crear → `GET /auth/session` trae el `companyId` → negocio 200.
 *  - La excepción al hook de scope es de ESTA ruta: con la misma sesión sin
 *    workspace, el resto de la v1 sigue en 403.
 *  - Uno por usuario: el segundo pedido es 409, y dos simultáneos crean uno.
 *  - El workspace nuevo es de su tenant: otra sesión recibe 404.
 *  - API key → 403; sin sesión → 401; la copy de FR-010 llega al cliente.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WORKSPACE_STATUSES, WORKSPACE_SUBSCRIPTION_STATUSES } from "@fastgram/contracts";
import { COMPANY_STATUS, SUBSCRIPTION_STATUS } from "@fastgram/db";

import { NO_WORKSPACE_MESSAGE } from "../src/server/app.js";
import { WORKSPACE_REQUIRES_SESSION_MESSAGE } from "../src/routes/workspace.js";
import {
  createTestIdentity,
  dataOf,
  errorOf,
  startApi,
  type ApiHarness,
  type Response,
  type TestIdentity,
} from "./helpers/harness.js";
import { openDb } from "./helpers/fixtures.js";

const SESSION_COPY =
  "We couldn't verify your session. Try again, or sign in again if this continues.";
const PATH = "/api/v1/onboarding/workspace";

let api: ApiHarness;
let testIdentity: TestIdentity;

interface SignedUp {
  readonly token: string;
  readonly userId: string;
}

async function signUp(label: string): Promise<SignedUp> {
  const res = await api.request({
    method: "POST",
    path: "/api/v1/auth/signup",
    token: null,
    body: {
      email: `${label}-${randomUUID().slice(0, 8)}@example.test`,
      password: `Pw-${randomUUID()}`,
      fullName: "Test User",
    },
  });
  expect(res.status).toBe(201);
  const data = dataOf(res);
  return {
    token: String(data["sessionToken"]),
    userId: String((data["user"] as Record<string, unknown>)["id"]),
  };
}

function asSession(
  token: string,
  opts: { method: "GET" | "POST"; path: string; body?: unknown; key?: string },
): Promise<Response> {
  return api.request({
    method: opts.method,
    path: opts.path,
    token: null,
    headers: { "x-fastgram-session": token },
    ...(opts.body === undefined ? {} : { body: opts.body }),
    ...(opts.key === undefined ? {} : { idempotencyKey: opts.key }),
  });
}

function createWorkspace(
  token: string,
  body: unknown = { name: "Acme" },
): Promise<Response> {
  return asSession(token, { method: "POST", path: PATH, body });
}

async function sessionCompanyId(token: string): Promise<unknown> {
  const res = await asSession(token, { method: "GET", path: "/api/v1/auth/session" });
  expect(res.status).toBe(200);
  return dataOf(res)["companyId"];
}

async function companiesOwnedBy(userId: string): Promise<number> {
  // Superusuario: cuenta lo que hay de verdad, sin RLS de por medio.
  const rows = await api.handle.sql<{ n: number }[]>`
    select count(*)::int as n from companies where owner_user_id = ${userId}`;
  return rows[0]?.n ?? -1;
}

beforeAll(async () => {
  testIdentity = createTestIdentity();
  api = await startApi({ identity: testIdentity.identity });
});

afterAll(async () => {
  await api?.close();
  await testIdentity?.close();
});

describe("signup → crear → sesión con companyId → negocio", () => {
  let user: SignedUp;
  let companyId: string;

  it("antes de crear: /auth/session da null y TODA la v1 sigue en 403 (la excepción es sólo esta ruta)", async () => {
    user = await signUp("flujo");
    expect(await sessionCompanyId(user.token)).toBeNull();

    for (const path of ["/api/v1/onboarding", "/api/v1/brand/profile"]) {
      const res = await asSession(user.token, { method: "GET", path });
      expect(res.status, path).toBe(403);
      expect(errorOf(res)).toEqual({ code: "forbidden", message: NO_WORKSPACE_MESSAGE });
    }
  });

  it("201 con el workspace: Free + trialing, en draft, con la zona del dueño", async () => {
    const res = await createWorkspace(user.token, {
      name: "  Acme Corp ",
      websiteUrl: `https://www.acme-${randomUUID().slice(0, 8)}.com/?utm_source=x`,
    });
    expect(res.status).toBe(201);
    const data = dataOf(res);
    expect(Object.keys(data).sort()).toEqual([
      "createdAt",
      "id",
      "name",
      "planId",
      "status",
      "subscriptionStatus",
      "timezone",
      "websiteUrl",
    ]);
    expect(data).toMatchObject({
      name: "Acme Corp",
      status: "draft",
      planId: "free",
      subscriptionStatus: "trialing",
    });
    expect(String(data["websiteUrl"])).toMatch(/^https:\/\/acme-[0-9a-f]{8}\.com$/);
    companyId = String(data["id"]);

    // Lo que no sale por el cable, mirado en la base.
    const [row] = await api.handle.sql<{ anchor: number; owner: string }[]>`
      select billing_anchor_day as anchor, owner_user_id as owner
      from companies where id = ${companyId}`;
    // FixedClock del arnés: 2026-09-21 → ancla 21 (día UTC de la creación).
    expect(row?.anchor).toBe(21);
    expect(row?.owner).toBe(user.userId);
    const [owner] = await api.handle.sql<{ tz: string; def: string | null }[]>`
      select timezone as tz, default_workspace_id as def from users where id = ${user.userId}`;
    expect(data["timezone"]).toBe(owner?.tz);
    expect(owner?.def).toBe(companyId);
    const memberships = await api.handle.sql<{ role: string; status: string }[]>`
      select role, status from workspace_memberships where user_id = ${user.userId}`;
    expect(memberships).toEqual([{ role: "owner", status: "active" }]);
  });

  it("GET /auth/session devuelve el companyId nuevo", async () => {
    expect(await sessionCompanyId(user.token)).toBe(companyId);
  });

  it("…con onboardingComplete: false mientras el workspace está en draft, y true al activarse", async () => {
    // Sin esto la web deducía «onboarding completo» de `companyId !== null`, y
    // quien recargaba a mitad del alta terminaba en /home sin fuente de marca.
    const draft = await asSession(user.token, {
      method: "GET",
      path: "/api/v1/auth/session",
    });
    expect(dataOf(draft)["onboardingComplete"]).toBe(false);

    await api.handle
      .sql`update companies set status = 'active' where id = ${companyId}::uuid`;
    const active = await asSession(user.token, {
      method: "GET",
      path: "/api/v1/auth/session",
    });
    expect(dataOf(active)["onboardingComplete"]).toBe(true);
    await api.handle
      .sql`update companies set status = 'draft' where id = ${companyId}::uuid`;
  });

  it("y las rutas de negocio responden 200 sobre él", async () => {
    const onboarding = await asSession(user.token, {
      method: "GET",
      path: "/api/v1/onboarding",
    });
    expect(onboarding.status).toBe(200);
    expect(dataOf(onboarding)["step"]).toBe("brand_source");

    const sources = await asSession(user.token, {
      method: "GET",
      path: "/api/v1/brand/sources",
    });
    expect(sources.status).toBe(200);
  });

  it("un segundo pedido es 409 workspace_already_exists y no crea nada", async () => {
    const res = await createWorkspace(user.token, { name: "Otra" });
    expect(await companiesOwnedBy(user.userId)).toBe(1);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatchObject({
      code: "conflict",
      details: { reason: "workspace_already_exists" },
    });
    // El id existente no se filtra en el cuerpo: el cliente lo lee de /auth/session.
    expect(res.raw).not.toContain(companyId);
  });
});

describe("dos pedidos simultáneos del mismo usuario", () => {
  /**
   * `Promise.all` de `inject` solo **no** solapa: medido, con el lock del
   * repositorio quitado este caso seguía verde (trampa 22). Así que se fuerza el
   * solapamiento como en `packages/db`: una transacción ajena —en otra conexión—
   * retiene la fila del usuario hasta que los dos pedidos están esperando un
   * lock. Con la guarda esperan en el `FOR NO KEY UPDATE`; sin ella pasan la
   * pregunta y esperan recién en el `UPDATE users`, y al soltarse commitean los
   * dos.
   */
  it("crean exactamente uno; el otro es 409", async () => {
    const user = await signUp("carrera");
    const side = openDb();
    try {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked!: () => void;
      const holding = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const blocker = side.sql.begin(async (tx) => {
        await tx`select 1 from users where id = ${user.userId} for no key update`;
        locked();
        await released;
      });
      await holding;

      const pending = [
        createWorkspace(user.token, { name: "Acme 1" }),
        createWorkspace(user.token, { name: "Acme 2" }),
      ];

      const deadline = Date.now() + 10_000;
      for (;;) {
        const [row] = await side.sql<{ n: number }[]>`
          select count(*)::int as n from pg_stat_activity
          where wait_event_type = 'Lock' and datname = current_database()`;
        if ((row?.n ?? 0) >= 2) break;
        if (Date.now() > deadline) throw new Error("los dos pedidos nunca se bloquearon");
        await new Promise((r) => setTimeout(r, 25));
      }
      release();
      await blocker;
      const results = await Promise.all(pending);

      // Negativa primero (trampa 35).
      expect(await companiesOwnedBy(user.userId)).toBe(1);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      const created = results.find((r) => r.status === 201);
      expect(await sessionCompanyId(user.token)).toBe(dataOf(created as Response)["id"]);
    } finally {
      await side.close();
    }
  });

  it("y en ráfaga sin forzar nada, igual: uno solo", async () => {
    const user = await signUp("rafaga");
    const results = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        createWorkspace(user.token, { name: `Acme ${i}` }),
      ),
    );
    expect(await companiesOwnedBy(user.userId)).toBe(1);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409, 409, 409]);
  });
});

describe("aislamiento", () => {
  it("la sesión de otro usuario no ve lo del workspace nuevo: 404, no 403", async () => {
    const a = await signUp("iso-a");
    const b = await signUp("iso-b");
    expect((await createWorkspace(a.token, { name: "Workspace A" })).status).toBe(201);
    expect((await createWorkspace(b.token, { name: "Workspace B" })).status).toBe(201);

    const source = await asSession(a.token, {
      method: "POST",
      path: "/api/v1/brand/sources",
      key: randomUUID(),
      body: { sourceType: "instagram", handle: `iso${randomUUID().slice(0, 6)}` },
    });
    expect(source.status).toBe(202);
    // El recurso público de §9.14 usa `_id` (convención Convex del original).
    const sourceId = String(dataOf(source)["_id"]);

    const cross = await asSession(b.token, {
      method: "GET",
      path: `/api/v1/brand/sources/${sourceId}`,
    });
    expect(cross.status).toBe(404);
    expect(errorOf(cross).code).toBe("not_found");

    const own = await asSession(a.token, {
      method: "GET",
      path: `/api/v1/brand/sources/${sourceId}`,
    });
    expect(own.status).toBe(200);
  });

  it("una API key (aunque sea válida) no crea workspaces: 403", async () => {
    const res = await api.request({
      method: "POST",
      path: PATH,
      body: { name: "Por key" },
    });
    expect(res.status).toBe(403);
    expect(errorOf(res)).toEqual({
      code: "forbidden",
      message: WORKSPACE_REQUIRES_SESSION_MESSAGE,
    });
  });

  it("API key + sesión sin workspace: sigue siendo 403 (la key no se ignora)", async () => {
    const user = await signUp("key-y-sesion");
    const res = await api.request({
      method: "POST",
      path: PATH,
      body: { name: "Mixto" },
      headers: { "x-fastgram-session": user.token },
    });
    expect(await companiesOwnedBy(user.userId)).toBe(0);
    expect(res.status).toBe(403);
  });

  it("sin credencial → 401 con el copy de §15.2 (antes de validar el body)", async () => {
    const res = await api.request({ method: "POST", path: PATH, token: null, body: {} });
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toBe('Bearer realm="api"');
    expect(errorOf(res)).toEqual({ code: "unauthorized", message: SESSION_COPY });
  });

  it("sesión manipulada → 401", async () => {
    const res = await createWorkspace("basura.firmada");
    expect(res.status).toBe(401);
    expect(errorOf(res).message).toBe(SESSION_COPY);
  });
});

describe("validación: la copy de FR-010 llega al cliente", () => {
  let user: SignedUp;
  beforeAll(async () => {
    user = await signUp("validacion");
  });

  const cases: [string, unknown, string, string][] = [
    ["nombre vacío", { name: "  " }, "Company name is required", "name"],
    ["nombre de 1", { name: "A" }, "Company name must be at least 2 characters", "name"],
    [
      "web localhost",
      { name: "Acme", websiteUrl: "http://localhost:3000" },
      "Localhost URLs are not allowed",
      "websiteUrl",
    ],
    [
      "web privada",
      { name: "Acme", websiteUrl: "http://10.0.0.1" },
      "Private IP addresses are not allowed",
      "websiteUrl",
    ],
    [
      "perfil social no es web",
      { name: "Acme", websiteUrl: "instagram.com/acme" },
      "Please enter a valid website URL",
      "websiteUrl",
    ],
  ];

  for (const [label, body, message, field] of cases) {
    it(`${label} → 400 «${message}»`, async () => {
      const res = await createWorkspace(user.token, body);
      expect(res.status).toBe(400);
      expect(errorOf(res)).toEqual({
        code: "bad_request",
        message,
        details: { field },
      });
    });
  }

  it("una clave fuera de contrato (planId) → 400, y no se crea nada", async () => {
    const res = await createWorkspace(user.token, { name: "Acme", planId: "pro" });
    expect(await companiesOwnedBy(user.userId)).toBe(0);
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("bad_request");
  });

  it("web ya registrada por otro → 409 website_already_registered con el copy literal", async () => {
    const web = `https://dup-${randomUUID().slice(0, 8)}.com`;
    const first = await signUp("web-1");
    expect(
      (await createWorkspace(first.token, { name: "Uno", websiteUrl: web })).status,
    ).toBe(201);

    // La misma web escrita de otra forma: la unicidad compara la canónica.
    const res = await createWorkspace(user.token, {
      name: "Dos",
      websiteUrl: web.replace("https://", "www."),
    });
    expect(await companiesOwnedBy(user.userId)).toBe(0);
    expect(res.status).toBe(409);
    expect(errorOf(res)).toEqual({
      code: "conflict",
      message: "This website is already registered.",
      details: { reason: "website_already_registered", field: "websiteUrl" },
    });
    // Y el usuario sigue pudiendo crear el suyo sin web.
    expect((await createWorkspace(user.token, { name: "Dos" })).status).toBe(201);
  });
});

describe("el contrato de estados coincide con la base", () => {
  it("WORKSPACE_STATUSES y WORKSPACE_SUBSCRIPTION_STATUSES son los enums de Postgres", () => {
    expect([...WORKSPACE_STATUSES]).toEqual([...COMPANY_STATUS]);
    expect([...WORKSPACE_SUBSCRIPTION_STATUSES]).toEqual([...SUBSCRIPTION_STATUS]);
  });
});

describe("usuario borrado entre la verificación y el alta", () => {
  it("sesión cuya fila de usuario ya no existe → 401 (sin escribir)", async () => {
    // Se borra la fila de `users` directamente: `auth_sessions` cae en cascada,
    // así que la sesión deja de verificar y el `onRequest` ya responde 401.
    const user = await signUp("borrado");
    await api.handle.sql`delete from users where id = ${user.userId}`;
    const res = await createWorkspace(user.token);
    expect(res.status).toBe(401);
    expect(await companiesOwnedBy(user.userId)).toBe(0);
  });
});
