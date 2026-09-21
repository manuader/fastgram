/**
 * Contrato del puerto `Identity` — IMPL ADR-008, PRD §9.1, §15, `NFR-006`.
 *
 * ADR-008 dice que el puerto existe «para poder volver atrás si la operación
 * resulta más cara que la licencia». Volver atrás significa cambiar de Better
 * Auth a un proveedor alojado sin tocar el resto: esta suite es la que hace
 * verificable esa promesa.
 *
 * El caso con más historia es `deleteUser`. §9.1 lo pide «verificado» porque
 * en el original falla a la vista (`Clerk could not mint a fresh Convex token
 * for account deletion`): un borrado a medias deja al usuario sin poder entrar
 * y sin poder irse. Por eso acá se exige idempotencia explícita.
 */

import type { Identity } from "../identity.js";
import {
  check,
  checkEqual,
  checkFuture,
  checkNonEmpty,
  checkRejectsWithCode,
  checkResolves,
  type AdapterFactory,
  type ContractHarness,
} from "./harness.js";

export interface IdentityContractSetup {
  readonly makeAdapter: AdapterFactory<Identity>;
  /** Token de sesión válido de un usuario de prueba. */
  readonly validSessionToken: string;
  /** Id de ese mismo usuario. */
  readonly knownUserId: string;
  /**
   * Usuario descartable para ejercer `deleteUser`. Omitirlo saltea ese caso —
   * y deja constancia de que el borrado no se verificó.
   */
  readonly disposableUserId?: string;
}

export function describeIdentityContract(
  harness: ContractHarness,
  name: string,
  setup: IdentityContractSetup,
): void {
  const { describe, it } = harness;

  describe(`Identity contract · ${name}`, () => {
    it("verifySessionToken devuelve el principal mínimo para autorizar", async () => {
      const identity = await setup.makeAdapter();
      const principal = await identity.verifySessionToken(setup.validSessionToken);

      checkEqual(principal.userId, setup.knownUserId, "userId del principal");
      checkNonEmpty(principal.email, "email del principal");
      checkNonEmpty(principal.sessionId, "sessionId: hace falta para poder revocar");
      checkFuture(principal.expiresAt, "expiresAt de la sesión");
    });

    it("un token basura es unauthorized, nunca otra cosa (§15.2)", async () => {
      const identity = await setup.makeAdapter();
      await checkRejectsWithCode(
        () => identity.verifySessionToken("no-soy-un-token"),
        ["unauthorized"],
        "token inválido",
      );
    });

    it("un token vacío también es unauthorized", async () => {
      const identity = await setup.makeAdapter();
      await checkRejectsWithCode(
        () => identity.verifySessionToken(""),
        ["unauthorized"],
        "token vacío: no puede colarse como bad_request y menos como éxito",
      );
    });

    it("getUser de un id desconocido devuelve null y no revela existencia (NFR-006)", async () => {
      const identity = await setup.makeAdapter();
      checkEqual(
        await identity.getUser("usuario-que-no-existe-0000"),
        null,
        "getUser de un id desconocido",
      );
    });

    it("createAuthorizationUrl conserva el state anti-CSRF", async () => {
      const identity = await setup.makeAdapter();
      const state = `state-${String(Date.now())}`;
      const authorization = await identity.createAuthorizationUrl({
        provider: "google",
        redirectUri: "https://example.invalid/auth/sso-callback",
        state,
      });

      checkNonEmpty(authorization.url, "url de autorización");
      check(
        authorization.url.includes(encodeURIComponent(state)) ||
          authorization.url.includes(state),
        "el state no viaja en la URL: sin él la vuelta no se puede validar",
      );
    });

    it("completeAuthorization con un code inválido es unauthorized o bad_request", async () => {
      const identity = await setup.makeAdapter();
      await checkRejectsWithCode(
        () =>
          identity.completeAuthorization({
            code: "code-invalido",
            state: "state-invalido",
            redirectUri: "https://example.invalid/auth/sso-callback",
          }),
        ["unauthorized", "bad_request"],
        "callback con code inválido",
      );
    });

    it("requestPasswordReset no revela si el email existe", async () => {
      const identity = await setup.makeAdapter();
      await checkResolves(
        () => identity.requestPasswordReset("nadie-con-esta-direccion@example.invalid"),
        "requestPasswordReset de un email desconocido: lanzar filtraría qué cuentas existen",
      );
    });

    it("revokeSession es idempotente", async () => {
      const identity = await setup.makeAdapter();
      await checkResolves(
        () => identity.revokeSession("sesion-que-no-existe-0000"),
        "revokeSession de una sesión inexistente",
      );
    });

    it("deleteUser es idempotente y deja al usuario irrecuperable (§9.1)", async () => {
      const identity = await setup.makeAdapter();
      const userId = setup.disposableUserId;
      if (userId === undefined) return;

      await identity.deleteUser(userId);
      checkEqual(await identity.getUser(userId), null, "getUser después de borrar");
      await checkResolves(
        () => identity.deleteUser(userId),
        "segundo deleteUser: un borrado a medias es el fallo que §9.1 quiere evitar",
      );
    });
  });
}
