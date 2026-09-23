/**
 * `/api/v1/auth/*` y la sesión `X-Fastgram-Session` — `P1-AUTH-002`.
 *
 * Contra Postgres real y **Better Auth real** (`BetterAuthIdentity` sobre la
 * base de test, secreto aleatorio por corrida). Lo único reemplazado es el
 * envío del email de recuperación, que no existe: un buzón en memoria.
 *
 * Lo que tiene que ser cierto, y cada `describe` mide una cosa:
 *
 *  - Alta → sesión → ruta de negocio: el `companyId` sale de la membresía.
 *  - Sin membresía: la sesión es válida, `companyId: null`, y el negocio 403.
 *  - Cross-tenant con sesión: 404, como con API key (§9.2).
 *  - Logout invalida; un token manipulado es 401 con el copy de §15.2.
 *  - API key + sesión: gana la key; una key inválida NO cae a la sesión.
 *  - Rate limit por email siempre, por IP sólo con proxy de confianza.
 *  - Ni tokens ni contraseñas en el log.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceMemberships, withoutCompany } from "@fastgram/db";
import { PortError } from "@fastgram/ports";
import { FixedClock } from "@fastgram/adapters";

import { NO_WORKSPACE_MESSAGE } from "../src/server/app.js";
import { INVALID_API_KEY_MESSAGE } from "../src/auth/api-keys.js";
import type { AuthIdentity } from "../src/auth/session.js";
import { TokenBucketLimiter } from "../src/http/rate-limit.js";
import { createMemoryBucketStore } from "../src/support/bucket-store.js";
import {
  createTestIdentity,
  dataOf,
  errorOf,
  startApi,
  type ApiHarness,
  type Response,
  type TestIdentity,
} from "./helpers/harness.js";

const SESSION_COPY =
  "We couldn't verify your session. Try again, or sign in again if this continues.";

/** Todo lo que no puede aparecer en el log. Se llena a medida que se crea. */
const secrets = new Set<string>();
const logLines: string[] = [];
const logStream = { write: (line: string) => void logLines.push(line) };

let api: ApiHarness;
let testIdentity: TestIdentity;

function password(label: string): string {
  const value = `Pw-${label}-${Math.random().toString(36).slice(2)}-x9`;
  secrets.add(value);
  return value;
}

function email(label: string): string {
  return `${label}-${Math.random().toString(36).slice(2, 8)}@example.test`;
}

async function signUp(
  harness: ApiHarness,
  body: { email: string; password: string; fullName?: string },
): Promise<Response> {
  const res = await harness.request({
    method: "POST",
    path: "/api/v1/auth/signup",
    token: null,
    body: { fullName: "Test User", ...body },
  });
  if (res.status === 201) {
    secrets.add(String(dataOf(res)["sessionToken"]));
  }
  return res;
}

function withSession(token: string, extra: Record<string, string> = {}) {
  return { "x-fastgram-session": token, ...extra };
}

async function addMembership(
  harness: ApiHarness,
  companyId: string,
  userId: string,
  status: "active" | "invited" = "active",
): Promise<void> {
  await withoutCompany(harness.handle.db, (tx) =>
    tx.insert(workspaceMemberships).values({ companyId, userId, role: "member", status }),
  );
}

beforeAll(async () => {
  testIdentity = createTestIdentity();
  api = await startApi({ identity: testIdentity.identity, logStream });
});

afterAll(async () => {
  await api?.close();
  await testIdentity?.close();
});

describe("alta → sesión → ruta de negocio", () => {
  let token: string;
  let userId: string;
  const mail = email("alta");

  it("signup responde 201 con {sessionToken, expiresAt ISO, user}", async () => {
    const res = await signUp(api, { email: mail, password: password("alta") });
    expect(res.status).toBe(201);
    const data = dataOf(res);
    expect(Object.keys(data).sort()).toEqual(["expiresAt", "sessionToken", "user"]);
    expect(typeof data["sessionToken"]).toBe("string");
    expect(new Date(String(data["expiresAt"])).toISOString()).toBe(data["expiresAt"]);
    const user = data["user"] as Record<string, unknown>;
    expect(user).toEqual({ id: expect.any(String), email: mail, emailVerified: false });
    token = String(data["sessionToken"]);
    userId = String(user["id"]);
  });

  it("sin membresía: la sesión vale, companyId null, y el negocio responde 403", async () => {
    const session = await api.request({
      method: "GET",
      path: "/api/v1/auth/session",
      token: null,
      headers: withSession(token),
    });
    expect(session.status).toBe(200);
    expect(dataOf(session)).toEqual({
      user: { id: userId, email: mail, emailVerified: false },
      companyId: null,
    });

    const business = await api.request({
      method: "GET",
      path: `/api/v1/content/${api.data.a.contentId}`,
      token: null,
      headers: withSession(token),
    });
    expect(business.status).toBe(403);
    expect(errorOf(business)).toEqual({
      code: "forbidden",
      message: NO_WORKSPACE_MESSAGE,
    });
  });

  it("una membresía sólo invitada no alcanza", async () => {
    await addMembership(api, api.data.b.companyId, userId, "invited");
    const session = await api.request({
      method: "GET",
      path: "/api/v1/auth/session",
      token: null,
      headers: withSession(token),
    });
    expect(dataOf(session)["companyId"]).toBeNull();
  });

  it("con membresía activa, el header resuelve el companyId de la membresía", async () => {
    await addMembership(api, api.data.a.companyId, userId);

    const session = await api.request({
      method: "GET",
      path: "/api/v1/auth/session",
      token: null,
      headers: withSession(token),
    });
    expect(dataOf(session)["companyId"]).toBe(api.data.a.companyId);

    const own = await api.request({
      method: "GET",
      path: `/api/v1/content/${api.data.a.contentId}`,
      token: null,
      headers: withSession(token),
    });
    expect(own.status).toBe(200);
    expect(dataOf(own)["_id"]).toBe(api.data.a.contentId);
  });

  it("cross-tenant: la sesión de A no ve el contenido de B (404, no 403)", async () => {
    const res = await api.request({
      method: "GET",
      path: `/api/v1/content/${api.data.b.contentId}`,
      token: null,
      headers: withSession(token),
    });
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe("not_found");

    // Y el mismo id, con la key de B, sí existe: el 404 de arriba es aislamiento.
    const withKeyB = await api.request({
      method: "GET",
      path: `/api/v1/content/${api.data.b.contentId}`,
      token: api.data.b.token,
    });
    expect(withKeyB.status).toBe(200);
  });

  it("API key + header de sesión: gana la key (ve B aunque la sesión sea de A)", async () => {
    const res = await api.request({
      method: "GET",
      path: `/api/v1/content/${api.data.b.contentId}`,
      token: api.data.b.token,
      headers: withSession(token),
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)["_id"]).toBe(api.data.b.contentId);
  });

  it("una API key inválida NO cae a la sesión válida", async () => {
    const res = await api.request({
      method: "GET",
      path: `/api/v1/content/${api.data.a.contentId}`,
      token: api.data.revokedToken,
      headers: withSession(token),
    });
    expect(res.status).toBe(401);
    expect(errorOf(res).message).toBe(INVALID_API_KEY_MESSAGE);
  });

  it("el header de sesión repetido cuenta como inválido (Node lo une con coma)", async () => {
    const res = await api.app.inject({
      method: "GET",
      url: "/api/v1/auth/session",
      headers: { "x-fastgram-session": [token, token] },
    });
    expect(res.statusCode).toBe(401);
  });

  it("la API no lee cookies: el token en una cookie no autoriza", async () => {
    const res = await api.request({
      method: "GET",
      path: `/api/v1/content/${api.data.a.contentId}`,
      token: null,
      headers: {
        cookie: `better-auth.session_token=${token}; fastgram_session=${token}`,
      },
    });
    expect(res.status).toBe(401);
  });
});

describe("token manipulado, logout", () => {
  it("un token con la firma alterada es 401 con el copy de §15.2, en negocio y en /session", async () => {
    const res = await signUp(api, { email: email("manip"), password: password("manip") });
    const token = String(dataOf(res)["sessionToken"]);
    // El valor es `<token>.<firma>`: se toca el último carácter de la firma.
    const last = token.at(-1) === "A" ? "B" : "A";
    const tampered = token.slice(0, -1) + last;
    // Y el token sin firma: la fila existe con ese valor en claro, pero sin el
    // secreto no se puede presentar.
    const unsigned = token.split(".")[0] ?? "";

    for (const bad of [tampered, unsigned, "basura", `${token}x`]) {
      const session = await api.request({
        method: "GET",
        path: "/api/v1/auth/session",
        token: null,
        headers: withSession(bad),
      });
      expect(session.status, bad === unsigned ? "sin firma" : bad).toBe(401);
      expect(errorOf(session)).toEqual({ code: "unauthorized", message: SESSION_COPY });
      expect(session.headers["www-authenticate"]).toBe('Bearer realm="api"');

      const business = await api.request({
        method: "GET",
        path: `/api/v1/content/${api.data.a.contentId}`,
        token: null,
        headers: withSession(bad),
      });
      expect(business.status).toBe(401);
      expect(errorOf(business).message).toBe(SESSION_COPY);
    }
  });

  it("logout invalida la sesión, y es idempotente", async () => {
    const res = await signUp(api, {
      email: email("logout"),
      password: password("logout"),
    });
    const token = String(dataOf(res)["sessionToken"]);
    const userId = String((dataOf(res)["user"] as Record<string, unknown>)["id"]);
    await addMembership(api, api.data.a.companyId, userId);

    const before = await api.request({
      method: "GET",
      path: `/api/v1/content/${api.data.a.contentId}`,
      token: null,
      headers: withSession(token),
    });
    expect(before.status).toBe(200);

    const out = await api.request({
      method: "POST",
      path: "/api/v1/auth/logout",
      token: null,
      headers: withSession(token),
    });
    expect(out.status).toBe(204);
    expect(out.raw).toBe("");

    const after = await api.request({
      method: "GET",
      path: `/api/v1/content/${api.data.a.contentId}`,
      token: null,
      headers: withSession(token),
    });
    expect(after.status).toBe(401);
    expect(errorOf(after).message).toBe(SESSION_COPY);

    for (const headers of [withSession(token), withSession("basura"), {}]) {
      const again = await api.request({
        method: "POST",
        path: "/api/v1/auth/logout",
        token: null,
        headers,
      });
      expect(again.status).toBe(204);
    }
  });
});

describe("signup y login", () => {
  const mail = email("login");
  const pass = password("login");

  beforeAll(async () => {
    expect((await signUp(api, { email: mail, password: pass })).status).toBe(201);
  });

  it("email duplicado → 409 conflict (también en otra capitalización)", async () => {
    for (const again of [mail, mail.toUpperCase()]) {
      const res = await signUp(api, { email: again, password: password("dup") });
      expect(res.status).toBe(409);
      expect(errorOf(res).code).toBe("conflict");
    }
  });

  it("login correcto → 200 con la misma forma que el alta", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/auth/login",
      token: null,
      body: { email: mail, password: pass },
    });
    expect(res.status).toBe(200);
    secrets.add(String(dataOf(res)["sessionToken"]));
    expect(Object.keys(dataOf(res)).sort()).toEqual([
      "expiresAt",
      "sessionToken",
      "user",
    ]);
  });

  it("contraseña mala y email inexistente dan el MISMO 401 neutro", async () => {
    const wrong = await api.request({
      method: "POST",
      path: "/api/v1/auth/login",
      token: null,
      body: { email: mail, password: password("mala") },
    });
    const unknown = await api.request({
      method: "POST",
      path: "/api/v1/auth/login",
      token: null,
      body: { email: email("nadie"), password: password("nadie") },
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.raw).toBe(unknown.raw);
    expect(errorOf(wrong)).toEqual({
      code: "unauthorized",
      message: "Invalid email or password",
    });
    expect(wrong.headers["www-authenticate"]).toBe('Bearer realm="api"');
  });

  it("body fuera de contrato → 400 bad_request (strict)", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/auth/signup",
      token: null,
      body: { email: email("x"), password: password("x"), fullName: "Ok", role: "admin" },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("bad_request");
  });

  it("las rutas de auth no piden API key, y una key no les cambia nada", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/auth/login",
      token: api.data.a.token,
      body: { email: mail, password: pass },
    });
    expect(res.status).toBe(200);
    secrets.add(String(dataOf(res)["sessionToken"]));
  });
});

describe("recuperación de contraseña", () => {
  const mail = email("reset");
  const oldPass = password("reset-old");
  const newPass = password("reset-new");

  it("202 exista o no la cuenta, con el mismo cuerpo", async () => {
    expect((await signUp(api, { email: mail, password: oldPass })).status).toBe(201);
    const before = testIdentity.resetEmails.length;

    const existing = await api.request({
      method: "POST",
      path: "/api/v1/auth/password-reset",
      token: null,
      body: { email: mail },
    });
    const missing = await api.request({
      method: "POST",
      path: "/api/v1/auth/password-reset",
      token: null,
      body: { email: email("no-existe") },
    });
    expect(existing.status).toBe(202);
    expect(missing.status).toBe(202);
    expect(existing.raw).toBe(missing.raw);
    // Sólo la cuenta que existe generó un email.
    expect(testIdentity.resetEmails.length).toBe(before + 1);
    for (const sent of testIdentity.resetEmails) secrets.add(sent.token);
  });

  it("token inválido → 400 bad_request", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/auth/password-reset/complete",
      token: null,
      body: { token: "no-es-un-token", newPassword: newPass },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("bad_request");
  });

  it("token válido → 204; cierra las sesiones abiertas y la contraseña nueva entra", async () => {
    const login = await api.request({
      method: "POST",
      path: "/api/v1/auth/login",
      token: null,
      body: { email: mail, password: oldPass },
    });
    const openSession = String(dataOf(login)["sessionToken"]);
    secrets.add(openSession);

    const sent = testIdentity.resetEmails.find((m) => m.email === mail);
    expect(sent).toBeDefined();
    const done = await api.request({
      method: "POST",
      path: "/api/v1/auth/password-reset/complete",
      token: null,
      body: { token: sent?.token ?? "", newPassword: newPass },
    });
    expect(done.status).toBe(204);

    const stale = await api.request({
      method: "GET",
      path: "/api/v1/auth/session",
      token: null,
      headers: withSession(openSession),
    });
    expect(stale.status).toBe(401);

    const reused = await api.request({
      method: "POST",
      path: "/api/v1/auth/password-reset/complete",
      token: null,
      body: { token: sent?.token ?? "", newPassword: password("otra") },
    });
    expect(reused.status).toBe(400);

    const fresh = await api.request({
      method: "POST",
      path: "/api/v1/auth/login",
      token: null,
      body: { email: mail, password: newPass },
    });
    expect(fresh.status).toBe(200);
    secrets.add(String(dataOf(fresh)["sessionToken"]));
  });
});

describe("el log", () => {
  it("se capturó algo (si no, la aserción de abajo no mide nada)", () => {
    expect(logLines.length).toBeGreaterThan(20);
    expect(logLines.some((l) => l.includes("/api/v1/auth/login"))).toBe(true);
  });

  it("ningún token, contraseña ni token de reset aparece en el log", () => {
    expect(secrets.size).toBeGreaterThan(10);
    const joined = logLines.join("\n");
    const leaked = [...secrets].filter((secret) => joined.includes(secret));
    expect(leaked).toEqual([]);
    // Ni la parte sin firma del token (la que está en claro en la base).
    for (const secret of secrets) {
      const head = secret.split(".")[0] ?? "";
      if (head.length >= 20) expect(joined.includes(head), "cabeza de token").toBe(false);
    }
    expect(joined.toLowerCase()).not.toContain("x-fastgram-session");
  });
});

describe("rate limit de /auth", () => {
  let limited: ApiHarness;
  let noProxy: ApiHarness;
  let identity: TestIdentity;

  const realLimiter = () =>
    new TokenBucketLimiter(
      createMemoryBucketStore(),
      // Congelado: el bucket no rellena durante el test, así que el límite
      // se ve exacto y no depende de cuánto tarda Better Auth en hashear.
      new FixedClock("2026-09-21T12:00:00.000Z"),
    );

  async function login(
    harness: ApiHarness,
    mail: string,
    forwardedFor?: string,
  ): Promise<Response> {
    return harness.request({
      method: "POST",
      path: "/api/v1/auth/login",
      token: null,
      body: { email: mail, password: "wrong-password" },
      ...(forwardedFor === undefined
        ? {}
        : { headers: { "x-forwarded-for": forwardedFor } }),
    });
  }

  beforeAll(async () => {
    identity = createTestIdentity();
    // `inject` llega desde 127.0.0.1: ése es el "BFF" de confianza.
    limited = await startApi({
      identity: identity.identity,
      limiter: realLimiter(),
      authTrustedProxies: ["127.0.0.1"],
    });
  });

  afterAll(async () => {
    await limited?.close();
    await noProxy?.close();
    await identity?.close();
  });

  it("por email: el intento 11 sobre la misma cuenta es 429, desde cualquier IP", async () => {
    const mail = email("bruta");
    for (let i = 0; i < 10; i++) {
      // Una IP distinta por intento: lo que corta es el email, no la IP.
      const res = await login(limited, mail, `198.51.100.${String(i + 1)}`);
      expect(res.status, `intento ${String(i + 1)}`).toBe(401);
    }
    const blocked = await login(limited, mail.toUpperCase(), "198.51.100.200");
    expect(blocked.status).toBe(429);
    expect(errorOf(blocked).code).toBe("rate_limited");
    expect(blocked.headers["retry-after"]).toBeDefined();
    const details = errorOf(blocked).details as { retryAfterMs: number };
    expect(details.retryAfterMs).toBeGreaterThan(0);

    // Otra cuenta, misma IP: sigue pasando.
    expect((await login(limited, email("otra"), "198.51.100.200")).status).toBe(401);
  });

  it("por IP (con proxy de confianza): el intento 21 desde la misma IP es 429", async () => {
    for (let i = 0; i < 20; i++) {
      const res = await login(limited, email(`ip${String(i)}`), "203.0.113.7");
      expect(res.status, `intento ${String(i + 1)}`).toBe(401);
    }
    expect((await login(limited, email("ip-21"), "203.0.113.7")).status).toBe(429);
    // Anteponer una IP falsa no cambia nada: se lee de derecha a izquierda.
    expect(
      (await login(limited, email("ip-spoof"), "192.0.2.99, 203.0.113.7")).status,
    ).toBe(429);
    // Otra IP detrás del mismo proxy: su propio bucket.
    expect((await login(limited, email("ip-otra"), "203.0.113.8")).status).toBe(401);
  });

  it("recuperación: el cuarto pedido por hora para el mismo email es 429", async () => {
    const mail = email("reset-spam");
    for (let i = 0; i < 3; i++) {
      const res = await limited.request({
        method: "POST",
        path: "/api/v1/auth/password-reset",
        token: null,
        body: { email: mail },
      });
      expect(res.status).toBe(202);
    }
    const res = await limited.request({
      method: "POST",
      path: "/api/v1/auth/password-reset",
      token: null,
      body: { email: mail },
    });
    expect(res.status).toBe(429);
  });

  it("sin AUTH_TRUSTED_PROXIES no hay bucket por IP: el X-Forwarded-For no se cree", async () => {
    noProxy = await startApi({ identity: identity.identity, limiter: realLimiter() });
    // Con bucket por IP, detrás del BFF el 21 sería 429 para TODO el producto.
    for (let i = 0; i < 25; i++) {
      const res = await login(noProxy, email(`np${String(i)}`), "203.0.113.50");
      expect(res.status, `intento ${String(i + 1)}`).toBe(401);
    }
    // El de email sigue.
    const mail = email("np-bruta");
    for (let i = 0; i < 10; i++) await login(noProxy, mail);
    expect((await login(noProxy, mail)).status).toBe(429);
  });
});

describe("sin identidad configurada", () => {
  let bare: ApiHarness;

  beforeAll(async () => {
    bare = await startApi();
  });

  afterAll(async () => {
    await bare?.close();
  });

  it("todo /auth/* responde 503 service_unavailable", async () => {
    for (const [method, path, body] of [
      [
        "POST",
        "/api/v1/auth/signup",
        { email: "a@example.test", password: "12345678", fullName: "Ana" },
      ],
      ["POST", "/api/v1/auth/login", { email: "a@example.test", password: "x" }],
      ["POST", "/api/v1/auth/logout", undefined],
      ["GET", "/api/v1/auth/session", undefined],
      ["POST", "/api/v1/auth/password-reset", { email: "a@example.test" }],
      [
        "POST",
        "/api/v1/auth/password-reset/complete",
        { token: "t", newPassword: "12345678" },
      ],
    ] as const) {
      const res = await bare.request({
        method,
        path,
        token: null,
        ...(body === undefined ? {} : { body }),
      });
      expect(res.status, `${method} ${path}`).toBe(503);
      expect(errorOf(res).code).toBe("service_unavailable");
    }
  });

  it("un header de sesión no autoriza nada: 401 como sin credencial", async () => {
    const res = await bare.request({
      method: "GET",
      path: `/api/v1/content/${bare.data.a.contentId}`,
      token: null,
      headers: withSession("cualquier-cosa"),
    });
    expect(res.status).toBe(401);
  });

  it("las rutas de negocio con API key siguen iguales", async () => {
    const res = await bare.request({
      method: "GET",
      path: `/api/v1/content/${bare.data.a.contentId}`,
    });
    expect(res.status).toBe(200);
  });
});

describe("proveedor de identidad caído", () => {
  let down: ApiHarness;

  const failing: AuthIdentity = {
    signUpWithPassword: () => Promise.reject(unavailable()),
    signInWithPassword: () => Promise.reject(unavailable()),
    verifySessionToken: () => Promise.reject(unavailable()),
    revokeSession: () => Promise.reject(unavailable()),
    requestPasswordReset: () => Promise.reject(unavailable()),
    completePasswordReset: () => Promise.reject(unavailable()),
  };
  function unavailable(): PortError {
    return new PortError(
      "provider_unavailable",
      "Authentication is temporarily unavailable",
      {
        source: "test",
      },
    );
  }

  beforeAll(async () => {
    down = await startApi({ identity: failing });
  });

  afterAll(async () => {
    await down?.close();
  });

  it("una sesión que no se puede comprobar es 503, no 401 (el BFF no debe tirarla)", async () => {
    for (const path of [
      "/api/v1/auth/session",
      `/api/v1/content/${down.data.a.contentId}`,
    ]) {
      const res = await down.request({
        method: "GET",
        path,
        token: null,
        headers: withSession("un-token-cualquiera"),
      });
      expect(res.status, path).toBe(503);
      expect(errorOf(res).code).toBe("service_unavailable");
    }
  });

  it("login con el proveedor caído es 503 service_unavailable, no un código del puerto", async () => {
    const res = await down.request({
      method: "POST",
      path: "/api/v1/auth/login",
      token: null,
      body: { email: "a@example.test", password: "x" },
    });
    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe("service_unavailable");
  });
});
