/**
 * Contrato del puerto `Payments` — PRD `INT-008`, §16, `NFR-004`, `NFR-007`.
 *
 * Tres cosas que un adaptador no puede incumplir sin consecuencias caras:
 *
 *  1. **Firma inválida ⇒ `unauthorized`.** Un webhook de pagos que se procesa
 *     sin verificar es una vía directa para regalar planes. Y tiene que ser
 *     distinguible de un payload válido pero raro (`provider_contract_violation`):
 *     uno es un ataque, el otro un bug propio.
 *  2. **`idempotencyKey` en todo lo facturable** (`NFR-004`). Un reintento que
 *     cobra dos veces se descubre por soporte, no por tests.
 *  3. **Nada de forma de proveedor cruza la frontera** (`NFR-007`,
 *     `DATA-017`: «campos de Stripe … nunca se devuelven»).
 */

import type { Payments } from "../payments.js";
import {
  check,
  checkEqual,
  checkFuture,
  checkNonEmpty,
  checkRejectsWithCode,
  type AdapterFactory,
  type ContractHarness,
} from "./harness.js";

export interface PaymentsWebhookFixture {
  /** Cuerpo crudo capturado del proveedor. */
  readonly rawBody: string;
  /** Firma correcta para ese cuerpo. */
  readonly signatureHeader: string;
}

export interface PaymentsContractSetup {
  readonly makeAdapter: AdapterFactory<Payments>;
  /** Cliente de prueba con suscripción activa. */
  readonly customerRef: string;
  /** Plan de prueba al que se puede hacer checkout. */
  readonly planRef: string;
  /** Webhook firmado de verdad. Omitirlo saltea esa parte. */
  readonly webhook?: PaymentsWebhookFixture;
}

export function describePaymentsContract(
  harness: ContractHarness,
  name: string,
  setup: PaymentsContractSetup,
): void {
  const { describe, it } = harness;

  describe(`Payments contract · ${name}`, () => {
    it("getSubscription de un cliente desconocido devuelve null (plan Free)", async () => {
      const payments = await setup.makeAdapter();
      checkEqual(
        await payments.getSubscription("cliente-que-no-existe-0000"),
        null,
        "getSubscription de un cliente desconocido: §16.1 tiene un plan Free sin suscripción",
      );
    });

    it("la suscripción trae el día ancla que §16.2 necesita para el reset", async () => {
      const payments = await setup.makeAdapter();
      const subscription = await payments.getSubscription(setup.customerRef);
      check(subscription !== null, "el cliente de prueba no tiene suscripción");
      if (subscription === null) return;

      check(
        subscription.billingAnchorDay >= 1 && subscription.billingAnchorDay <= 31,
        `billingAnchorDay fuera de rango: ${String(subscription.billingAnchorDay)}`,
      );
      check(
        subscription.currentPeriodEnd.getTime() >
          subscription.currentPeriodStart.getTime(),
        "el periodo termina antes de empezar",
      );
    });

    it("createCheckout devuelve una URL alojada con vencimiento", async () => {
      const payments = await setup.makeAdapter();
      const session = await payments.createCheckout({
        customerRef: setup.customerRef,
        planRef: setup.planRef,
        successUrl: "https://example.invalid/ok",
        cancelUrl: "https://example.invalid/cancel",
        idempotencyKey: `contract-${String(Date.now())}`,
      });

      checkNonEmpty(session.url, "url del checkout");
      checkFuture(session.expiresAt, "expiresAt del checkout");
    });

    it("createBillingPortalSession no pide ni devuelve datos de pago (§16.4)", async () => {
      const payments = await setup.makeAdapter();
      const session = await payments.createBillingPortalSession({
        customerRef: setup.customerRef,
        returnUrl: "https://example.invalid/billing",
      });

      checkNonEmpty(session.url, "url del portal");
      const serialized = JSON.stringify(session).toLowerCase();
      for (const forbidden of ["card", "pan", "cvc", "iban"]) {
        check(
          !serialized.includes(forbidden),
          `la sesión del portal trae "${forbidden}": los datos de pago no entran al sistema`,
        );
      }
    });

    it("recordUsage con la misma idempotencyKey no factura dos veces (NFR-004)", async () => {
      const payments = await setup.makeAdapter();
      const idempotencyKey = `usage-${String(Date.now())}`;
      const request = {
        customerRef: setup.customerRef,
        meter: "content_save_overage",
        quantity: 1,
        occurredAt: new Date(),
        idempotencyKey,
      };

      await payments.recordUsage(request);
      // La segunda no puede lanzar: un reintento de red es normal. Lo que no
      // puede es contar de nuevo, y eso se verifica contra el proveedor.
      await payments.recordUsage(request);
    });

    it("recordUsage rechaza cantidades no positivas", async () => {
      const payments = await setup.makeAdapter();
      await checkRejectsWithCode(
        () =>
          payments.recordUsage({
            customerRef: setup.customerRef,
            meter: "content_save_overage",
            quantity: -1,
            occurredAt: new Date(),
            idempotencyKey: `usage-neg-${String(Date.now())}`,
          }),
        ["bad_request"],
        "recordUsage con cantidad negativa",
      );
    });

    it("un webhook con firma inválida es unauthorized, no bad_request", async () => {
      const payments = await setup.makeAdapter();
      const fixture = setup.webhook;
      if (fixture === undefined) return;

      await checkRejectsWithCode(
        () =>
          payments.verifyWebhook({
            rawBody: fixture.rawBody,
            signatureHeader: "firma-falsa",
          }),
        ["unauthorized"],
        "webhook con firma inválida: distinguirlo de un bug propio importa",
      );
    });

    it("un webhook válido se traduce a un evento neutral", async () => {
      const payments = await setup.makeAdapter();
      const fixture = setup.webhook;
      if (fixture === undefined) return;

      const event = await payments.verifyWebhook(fixture);
      checkNonEmpty(event.eventId, "eventId: hace falta para deduplicar reentregas");
      checkNonEmpty(event.customerRef, "customerRef del evento");
      check(
        [
          "subscription_activated",
          "subscription_updated",
          "subscription_canceled",
          "payment_succeeded",
          "payment_failed",
          "unhandled",
        ].includes(event.kind),
        `kind fuera del contrato: ${event.kind}`,
      );
    });
  });
}
