/**
 * `BetterAuthIdentity` contra Postgres real — `P1-AUTH-001`, ADR-008, PRD §9.1.
 *
 * ## Qué base usa
 *
 * `DATABASE_URL`, o el Postgres del `docker compose` de desarrollo, **migrado
 * hasta `0011`** (`pnpm db:migrate`): las tablas `auth_*` y las columnas nuevas de
 * `users` las crea esa migración, no este archivo. `packages/adapters` no depende
 * de `@fastgram/db` y agregarlo es tocar un `package.json`. Sin base, o sin la
 * migración, los casos se saltean **con el motivo en el nombre**.
 *
 * Cada corrida usa emails con un sufijo aleatorio y borra lo que creó.
 *
 * ## La suite de contrato
 *
 * Corre entera salvo un caso: `createAuthorizationUrl conserva el state` exige
 * una URL de SSO, y este adaptador no tiene proveedor que configurar (el PRD no
 * nombra ninguno; `P1-AUTH-003`). Ese caso se saltea **renombrado con el
 * motivo**, y su lado negativo —que falle con `bad_request` estable— se prueba
 * abajo.
 */

import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { describeIdentityContract, isPortError, type PortError } from "@fastgram/ports";

import {
  BetterAuthIdentity,
  SSO_NOT_CONFIGURED_MESSAGE,
  type BetterAuthIdentityConfig,
  type IdentityEmailMessage,
} from "./better-auth-identity.js";
import { identityDatabaseUrl } from "../../test/identity-db.js";

// Base propia (`…_adapters`): la de `apps/api` trunca `users` en paralelo.
const CONNECTION_STRING = identityDatabaseUrl();

async function probe(): Promise<string | null> {
  const client = new pg.Client({ connectionString: CONNECTION_STRING });
  try {
    await client.connect();
    const { rows } = await client.query<{ n: number }>(
      `select count(*)::int as n from information_schema.tables
        where table_schema = 'public'
          and table_name in ('auth_sessions', 'auth_accounts', 'auth_verifications')`,
    );
    if (rows[0]?.n !== 3) return "la base no tiene la migración 0011 (pnpm db:migrate)";
    return null;
  } catch (error) {
    return `no hay Postgres: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await client.end().catch(() => undefined);
  }
}

const unavailable = await probe();
const reason = unavailable === null ? null : `SALTEADA — ${unavailable}`;
const suffix = reason === null ? "" : ` · ${reason}`;
const itDb = reason === null ? it : it.skip;

/** Secreto de prueba generado en cada corrida: nunca un valor fijo en el repo. */
const SECRET = randomBytes(32).toString("base64url");
const RUN = randomUUID().slice(0, 8);
const PASSWORD = `pw-${randomBytes(9).toString("base64url")}`;

let pool: pg.Pool;
const outbox: IdentityEmailMessage[] = [];
const createdUserIds = new Set<string>();

function config(
  overrides: Partial<BetterAuthIdentityConfig> = {},
): BetterAuthIdentityConfig {
  return {
    pool,
    secret: SECRET,
    baseUrl: "http://localhost:3000",
    sendPasswordResetEmail: async (message) => {
      outbox.push(message);
    },
    logLevel: "error",
    ...overrides,
  };
}

function makeAdapter(): BetterAuthIdentity {
  return new BetterAuthIdentity(config());
}

function email(tag: string): string {
  return `${tag}+${RUN}-${randomUUID().slice(0, 6)}@example.test`;
}

async function signUp(identity: BetterAuthIdentity, tag: string) {
  const address = email(tag);
  const result = await identity.signUpWithPassword({
    email: address,
    password: PASSWORD,
    fullName: `User ${tag}`,
  });
  createdUserIds.add(result.principal.userId);
  return { ...result, email: address };
}

async function rejection(promise: Promise<unknown>): Promise<PortError> {
  const outcome = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  if (outcome === null) throw new Error("no lanzó");
  if (!isPortError(outcome))
    throw new Error(`lanzó algo que no es PortError: ${String(outcome)}`);
  return outcome;
}

const seeded = { token: "", userId: "", disposableUserId: "" };

beforeAll(async () => {
  if (reason !== null) return;
  pool = new pg.Pool({ connectionString: CONNECTION_STRING, max: 5 });
  const identity = makeAdapter();
  const known = await signUp(identity, "known");
  const disposable = await signUp(identity, "disposable");
  seeded.token = known.sessionToken;
  seeded.userId = known.principal.userId;
  seeded.disposableUserId = disposable.principal.userId;
});

afterAll(async () => {
  if (reason !== null) return;
  const identity = makeAdapter();
  for (const userId of createdUserIds) {
    await pool.query(`delete from companies where owner_user_id = $1`, [userId]);
    await identity.deleteUser(userId);
  }
  await pool.end();
});

/* ------------------------------------------------------------------------ *
 * Suite de contrato del puerto
 * ------------------------------------------------------------------------ */

const SSO_CASE = "createAuthorizationUrl conserva el state anti-CSRF";

describeIdentityContract(
  {
    describe,
    it: (name, body) => {
      if (reason !== null) return it.skip(`${name}${suffix}`, body);
      if (name === SSO_CASE) {
        return it.skip(
          `${name} · SALTEADA — sin proveedor de SSO: el PRD no nombra ninguno (P1-AUTH-003)`,
          body,
        );
      }
      return it(name, body);
    },
  },
  "better-auth",
  {
    makeAdapter,
    // Getters: los valores existen recién después del `beforeAll`, y la suite
    // los lee adentro de cada caso.
    get validSessionToken() {
      return seeded.token;
    },
    get knownUserId() {
      return seeded.userId;
    },
    get disposableUserId() {
      return seeded.disposableUserId;
    },
  },
);

/* ------------------------------------------------------------------------ *
 * Comportamiento propio
 * ------------------------------------------------------------------------ */

describe(`BetterAuthIdentity — sesiones${suffix}`, () => {
  itDb("signup → verify → revoke → verify falla con unauthorized", async () => {
    const identity = makeAdapter();
    const { sessionToken, principal, isNewUser } = await signUp(identity, "revoke");
    expect(isNewUser).toBe(true);

    const verified = await identity.verifySessionToken(sessionToken);
    expect(verified.userId).toBe(principal.userId);
    expect(verified.sessionId).toBe(principal.sessionId);

    await identity.revokeSession(verified.sessionId);

    const error = await rejection(identity.verifySessionToken(sessionToken));
    expect(error.code).toBe("unauthorized");
    // Idempotente: revocar otra vez no es error.
    await identity.revokeSession(verified.sessionId);
  });

  itDb("revocar una sesión no toca las otras del mismo usuario", async () => {
    const identity = makeAdapter();
    const first = await signUp(identity, "multi");
    const second = await identity.signInWithPassword({
      email: first.email,
      password: PASSWORD,
    });
    expect(second.isNewUser).toBe(false);

    await identity.revokeSession(first.principal.sessionId);

    expect((await rejection(identity.verifySessionToken(first.sessionToken))).code).toBe(
      "unauthorized",
    );
    const alive = await identity.verifySessionToken(second.sessionToken);
    expect(alive.sessionId).toBe(second.principal.sessionId);
  });

  itDb("un token manipulado es unauthorized", async () => {
    const identity = makeAdapter();
    const token = seeded.token;
    const last = token.at(-1) === "A" ? "B" : "A";
    const tampered = `${token.slice(0, -1)}${last}`;
    expect((await rejection(identity.verifySessionToken(tampered))).code).toBe(
      "unauthorized",
    );
  });

  itDb(
    "el token de la base sin firma no alcanza (una lectura de auth_sessions no forja cookies)",
    async () => {
      const identity = makeAdapter();
      const { rows } = await pool.query<{ token: string }>(
        `select token from auth_sessions where user_id = $1 limit 1`,
        [seeded.userId],
      );
      const raw = rows[0]?.token;
      expect(raw).toBeDefined();
      // La aserción negativa primero (trampa 35): el token crudo es rechazado…
      expect((await rejection(identity.verifySessionToken(raw ?? ""))).code).toBe(
        "unauthorized",
      );
      // …y el firmado, que es su mismo valor más la firma, sí pasa.
      expect(seeded.token.startsWith(`${raw ?? "∅"}.`)).toBe(true);
    },
  );

  itDb("un token firmado con otro secreto es unauthorized", async () => {
    const other = new BetterAuthIdentity(
      config({ secret: randomBytes(32).toString("base64url") }),
    );
    expect((await rejection(other.verifySessionToken(seeded.token))).code).toBe(
      "unauthorized",
    );
  });

  itDb("un token con `;` no puede inyectar otra cookie", async () => {
    const identity = makeAdapter();
    const error = await rejection(identity.verifySessionToken(`x; ${seeded.token}`));
    expect(error.code).toBe("unauthorized");
  });

  itDb(
    "token basura, revocado y de usuario borrado dan el mismo mensaje público",
    async () => {
      const identity = makeAdapter();
      const revoked = await signUp(identity, "same-msg");
      await identity.revokeSession(revoked.principal.sessionId);
      const deleted = await signUp(identity, "same-msg-del");
      await identity.deleteUser(deleted.principal.userId);

      const a = await rejection(identity.verifySessionToken("basura"));
      const b = await rejection(identity.verifySessionToken(revoked.sessionToken));
      const c = await rejection(identity.verifySessionToken(deleted.sessionToken));
      expect(b.toPublic()).toEqual(a.toPublic());
      expect(c.toPublic()).toEqual(a.toPublic());
    },
  );
});

describe(`BetterAuthIdentity — alta y login con contraseña${suffix}`, () => {
  itDb("email duplicado es conflict — también con otra capitalización", async () => {
    const identity = makeAdapter();
    const first = await signUp(identity, "dup");
    const again = await rejection(
      identity.signUpWithPassword({
        email: first.email,
        password: PASSWORD,
        fullName: "Otra Persona",
      }),
    );
    expect(again.code).toBe("conflict");

    const upper = await rejection(
      identity.signUpWithPassword({
        email: first.email.toUpperCase(),
        password: PASSWORD,
        fullName: "Otra Persona",
      }),
    );
    expect(upper.code).toBe("conflict");
  });

  itDb(
    "dos altas concurrentes con el mismo email: una gana, las demás conflict (trampa 37)",
    async () => {
      const identity = makeAdapter();
      const address = email("race");
      const outcomes = await Promise.allSettled(
        Array.from({ length: 5 }, () =>
          identity.signUpWithPassword({
            email: address,
            password: PASSWORD,
            fullName: "Race",
          }),
        ),
      );
      const won = outcomes.filter((o) => o.status === "fulfilled");
      const lost = outcomes.filter((o) => o.status === "rejected");
      for (const o of won) createdUserIds.add(o.value.principal.userId);

      expect(won).toHaveLength(1);
      for (const o of lost) {
        expect(isPortError(o.reason) && o.reason.code).toBe("conflict");
      }
    },
  );

  itDb(
    "contraseña corta, email inválido y nombre de 1 carácter son bad_request",
    async () => {
      const identity = makeAdapter();
      const short = await rejection(
        identity.signUpWithPassword({
          email: email("short"),
          password: "1234",
          fullName: "Ok",
        }),
      );
      expect(short.code).toBe("bad_request");

      const badEmail = await rejection(
        identity.signUpWithPassword({
          email: "no-es-email",
          password: PASSWORD,
          fullName: "Ok",
        }),
      );
      expect(badEmail.code).toBe("bad_request");

      const name = await rejection(
        identity.signUpWithPassword({
          email: email("name"),
          password: PASSWORD,
          fullName: "A",
        }),
      );
      expect(name.code).toBe("bad_request");

      const tz = await rejection(
        identity.signUpWithPassword({
          email: email("tz"),
          password: PASSWORD,
          fullName: "Ok Ok",
          timezone: "Mars/Olympus",
        }),
      );
      expect(tz.code).toBe("bad_request");
    },
  );

  itDb(
    "login con contraseña errónea y con email desconocido: unauthorized, mismo mensaje",
    async () => {
      const identity = makeAdapter();
      const known = await signUp(identity, "login");
      const wrong = await rejection(
        identity.signInWithPassword({ email: known.email, password: `${PASSWORD}x` }),
      );
      const unknown = await rejection(
        identity.signInWithPassword({ email: email("nobody"), password: PASSWORD }),
      );
      expect(wrong.code).toBe("unauthorized");
      expect(unknown.toPublic()).toEqual(wrong.toPublic());
    },
  );

  itDb(
    "el alta escribe la fila de users con timezone y sin external_identity_id",
    async () => {
      const identity = makeAdapter();
      const address = email("row");
      const result = await identity.signUpWithPassword({
        email: address,
        password: PASSWORD,
        fullName: "  Row Person  ",
        timezone: "America/Argentina/Buenos_Aires",
      });
      createdUserIds.add(result.principal.userId);

      const { rows } = await pool.query<{
        full_name: string;
        timezone: string;
        external_identity_id: string | null;
        email_verified: boolean;
        deletion_status: string;
      }>(
        `select full_name, timezone, external_identity_id, email_verified, deletion_status
         from users where id = $1`,
        [result.principal.userId],
      );
      expect(rows[0]).toEqual({
        full_name: "Row Person",
        timezone: "America/Argentina/Buenos_Aires",
        external_identity_id: null,
        email_verified: false,
        deletion_status: "none",
      });
    },
  );
});

describe(`BetterAuthIdentity — NFR-007${suffix}`, () => {
  itDb(
    "ni el principal, ni el usuario, ni el resultado traen tokens o hashes del proveedor",
    async () => {
      const identity = makeAdapter();
      const result = await signUp(identity, "nfr007");

      expect(Object.keys(result.principal).sort()).toEqual(
        ["email", "emailVerified", "expiresAt", "sessionId", "userId"].sort(),
      );
      const { email: _email, ...authorization } = result;
      expect(Object.keys(authorization).sort()).toEqual(
        ["isNewUser", "principal", "sessionToken"].sort(),
      );

      const user = await identity.getUser(result.principal.userId);
      expect(user).not.toBeNull();
      const allowed = new Set([
        "userId",
        "email",
        "emailVerified",
        "displayName",
        "avatarUrl",
        "createdAt",
      ]);
      for (const key of Object.keys(user ?? {})) expect(allowed.has(key), key).toBe(true);

      const { rows } = await pool.query<{ password: string; token: string }>(
        `select a.password, s.token
         from auth_accounts a join auth_sessions s on s.user_id = a.user_id
        where a.user_id = $1 limit 1`,
        [result.principal.userId],
      );
      const serialized = JSON.stringify([result.principal, user]);
      expect(serialized).not.toContain(rows[0]?.password ?? "∅");
      expect(serialized).not.toContain(rows[0]?.token ?? "∅");
    },
  );
});

describe(`BetterAuthIdentity — borrado de cuenta (§9.1)${suffix}`, () => {
  itDb("deleteUser invalida las sesiones vivas y el login", async () => {
    const identity = makeAdapter();
    const account = await signUp(identity, "delete");
    await identity.verifySessionToken(account.sessionToken); // vivía

    await identity.deleteUser(account.principal.userId);

    expect(
      (await rejection(identity.verifySessionToken(account.sessionToken))).code,
    ).toBe("unauthorized");
    expect(
      (
        await rejection(
          identity.signInWithPassword({ email: account.email, password: PASSWORD }),
        )
      ).code,
    ).toBe("unauthorized");
    expect(await identity.getUser(account.principal.userId)).toBeNull();

    const { rows } = await pool.query<{ n: number }>(
      `select (select count(*) from auth_sessions where user_id = $1)
            + (select count(*) from auth_accounts where user_id = $1) as n`,
      [account.principal.userId],
    );
    expect(Number(rows[0]?.n)).toBe(0);
  });

  itDb(
    "un dueño de workspace no se borra: conflict, y la cuenta queda entera",
    async () => {
      const identity = makeAdapter();
      const owner = await signUp(identity, "owner");
      await pool.query(
        `insert into companies (name, owner_user_id, plan_id, billing_anchor_day, timezone)
       values ('Owned', $1, 'free', 1, 'UTC')`,
        [owner.principal.userId],
      );

      const error = await rejection(identity.deleteUser(owner.principal.userId));
      expect(error.code).toBe("conflict");
      // Nada a medias: la sesión sigue viva y la contraseña sigue sirviendo.
      const still = await identity.verifySessionToken(owner.sessionToken);
      expect(still.userId).toBe(owner.principal.userId);
      const again = await identity.signInWithPassword({
        email: owner.email,
        password: PASSWORD,
      });
      expect(again.principal.userId).toBe(owner.principal.userId);
    },
  );
});

describe(`BetterAuthIdentity — recuperación de contraseña (§15.3)${suffix}`, () => {
  itDb(
    "reset: llega el token, la contraseña cambia, las sesiones viejas mueren y el token no se reusa",
    async () => {
      const identity = makeAdapter();
      const account = await signUp(identity, "reset");
      const before = outbox.length;

      await identity.requestPasswordReset(account.email);

      const message = outbox.slice(before).find((m) => m.email === account.email);
      expect(message).toBeDefined();
      const token = message?.token ?? "";
      const newPassword = `${PASSWORD}-new`;

      await identity.completePasswordReset({ token, newPassword });

      expect(
        (await rejection(identity.verifySessionToken(account.sessionToken))).code,
      ).toBe("unauthorized");
      expect(
        (
          await rejection(
            identity.signInWithPassword({ email: account.email, password: PASSWORD }),
          )
        ).code,
      ).toBe("unauthorized");
      const fresh = await identity.signInWithPassword({
        email: account.email,
        password: newPassword,
      });
      expect(fresh.principal.userId).toBe(account.principal.userId);

      const reused = await rejection(
        identity.completePasswordReset({ token, newPassword: `${newPassword}-2` }),
      );
      expect(reused.code).toBe("unauthorized");
    },
  );

  itDb(
    "requestPasswordReset de un email desconocido no envía nada y no lanza",
    async () => {
      const identity = makeAdapter();
      const before = outbox.length;
      await identity.requestPasswordReset(email("ghost"));
      expect(outbox.length).toBe(before);
    },
  );
});

describe(`BetterAuthIdentity — SSO sin proveedor (P1-AUTH-003)${suffix}`, () => {
  itDb(
    "createAuthorizationUrl y completeAuthorization fallan con bad_request estable",
    async () => {
      const identity = makeAdapter();
      const create = await rejection(
        identity.createAuthorizationUrl({
          provider: "google",
          redirectUri: "https://example.invalid/auth/sso-callback",
          state: "s",
        }),
      );
      expect(create.toPublic()).toEqual({
        code: "bad_request",
        message: SSO_NOT_CONFIGURED_MESSAGE,
      });
      const complete = await rejection(
        identity.completeAuthorization({
          code: "c",
          state: "s",
          redirectUri: "https://example.invalid/auth/sso-callback",
        }),
      );
      expect(complete.code).toBe("bad_request");
    },
  );
});
