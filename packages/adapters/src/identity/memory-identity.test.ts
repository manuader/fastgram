import { describe, expect, it } from "vitest";
import { describeIdentityContract, isPortError } from "@fastgram/ports";
import { MemoryIdentity } from "./memory-identity.js";

/**
 * Primera ejecución de la suite de contrato de `Identity`.
 *
 * Corre contra el adaptador en memoria porque **el de Better Auth todavía no
 * existe** (ADR-008 lo elige; el paquete no está declarado). Que los nueve
 * casos corran ya deja probado el armazón: cuando aparezca el adaptador real,
 * un fallo apunta al adaptador y no a la suite.
 */
const KNOWN_USER = "usr_conocido";
const DISPOSABLE_USER = "usr_descartable";
const SESSION_TOKEN = "tok_valido";

function makeAdapter(): MemoryIdentity {
  return new MemoryIdentity({
    users: [
      {
        userId: KNOWN_USER,
        email: "conocido@example.invalid",
        sessionToken: SESSION_TOKEN,
      },
      { userId: DISPOSABLE_USER, email: "descartable@example.invalid" },
    ],
  });
}

describeIdentityContract({ describe, it }, "memory", {
  makeAdapter,
  validSessionToken: SESSION_TOKEN,
  knownUserId: KNOWN_USER,
  disposableUserId: DISPOSABLE_USER,
});

describe("MemoryIdentity — comportamiento propio del adaptador", () => {
  it("el flujo completo de SSO devuelve una sesión usable", async () => {
    const identity = makeAdapter();
    const state = "state-anti-csrf";
    const authorization = await identity.createAuthorizationUrl({
      provider: "google",
      redirectUri: "https://example.invalid/auth/sso-callback",
      state,
    });
    expect(authorization.url).toContain(encodeURIComponent(state));

    const code = identity.issueAuthorizationCode(KNOWN_USER, state);
    const result = await identity.completeAuthorization({
      code,
      state,
      redirectUri: "https://example.invalid/auth/sso-callback",
    });

    expect(result.principal.userId).toBe(KNOWN_USER);
    // Ya estaba sembrado, así que no es alta nueva: `FR-010` no se dispara.
    expect(result.isNewUser).toBe(false);

    const principal = await identity.verifySessionToken(result.sessionToken);
    expect(principal.sessionId).toBe(result.principal.sessionId);
  });

  it("un code válido con otro state es bad_request, no una sesión", async () => {
    // El state es la única defensa contra CSRF en el callback. Aceptar uno
    // distinto haría que la validación sea decorativa.
    const identity = makeAdapter();
    const code = identity.issueAuthorizationCode(KNOWN_USER, "el-bueno");
    const error = await identity
      .completeAuthorization({
        code,
        state: "el-del-atacante",
        redirectUri: "https://example.invalid/auth/sso-callback",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isPortError(error) && error.code).toBe("bad_request");
  });

  it("un code se consume una sola vez", async () => {
    const identity = makeAdapter();
    const code = identity.issueAuthorizationCode(KNOWN_USER, "s");
    await identity.completeAuthorization({
      code,
      state: "s",
      redirectUri: "https://example.invalid/auth/sso-callback",
    });
    const error = await identity
      .completeAuthorization({
        code,
        state: "s",
        redirectUri: "https://example.invalid/auth/sso-callback",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isPortError(error) && error.code).toBe("unauthorized");
  });

  it("borrar al usuario invalida sus sesiones vivas (§9.1)", async () => {
    // El fallo del original: un borrado a medias deja al usuario sin poder
    // entrar y sin poder irse. Acá se verifica el lado que sí depende del
    // adaptador: ningún token sobrevive a la cuenta.
    const identity = makeAdapter();
    await identity.verifySessionToken(SESSION_TOKEN); // vivía
    await identity.deleteUser(KNOWN_USER);

    const error = await identity.verifySessionToken(SESSION_TOKEN).then(
      () => null,
      (e: unknown) => e,
    );
    expect(isPortError(error) && error.code).toBe("unauthorized");
  });

  it("una sesión vencida es unauthorized, no un principal caducado", async () => {
    const identity = new MemoryIdentity({
      users: [{ userId: "u", email: "u@example.invalid", sessionToken: "t" }],
      sessionTtlSeconds: 0.001,
    });
    await new Promise((r) => setTimeout(r, 20));
    const error = await identity.verifySessionToken("t").then(
      () => null,
      (e: unknown) => e,
    );
    expect(isPortError(error) && error.code).toBe("unauthorized");
  });

  it("el mensaje de unauthorized no distingue por qué falló", async () => {
    // Token basura, token vencido y usuario borrado tienen que ser
    // indistinguibles desde afuera: si no, es un oráculo.
    const identity = makeAdapter();
    const basura = await identity
      .verifySessionToken("no-existe")
      .catch((e: unknown) => e);
    const vacio = await identity.verifySessionToken("").catch((e: unknown) => e);
    expect(isPortError(basura) && basura.toPublic()).toEqual(
      isPortError(vacio) && vacio.toPublic(),
    );
  });

  it("una redirectUri que no es absoluta es bad_request", async () => {
    const identity = makeAdapter();
    const error = await identity
      .createAuthorizationUrl({
        provider: "google",
        redirectUri: "/auth/sso-callback",
        state: "s",
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isPortError(error) && error.code).toBe("bad_request");
  });
});
