import { describe, expect, it } from "vitest";
import { describePaymentsContract, type SubscriptionSnapshot } from "@fastgram/ports";
import { FixedClock } from "../clock/index.js";
import { MemoryPayments, type MemoryWebhookPayload } from "./memory-payments.js";

/**
 * Primera ejecución de las ocho aserciones de contrato de `Payments`.
 *
 * El secreto es una constante del archivo y no un valor por instancia porque
 * `makeAdapter` construye un adaptador nuevo **por caso**: si cada instancia
 * firmara con un secreto propio, el fixture firmado por una no verificaría en
 * la otra y el fallo parecería un bug de firma.
 */
const SECRET = "contrato-memory";
const CUSTOMER = "cus_memoria";
const PLAN = "plan_memoria";

const SUBSCRIPTION: SubscriptionSnapshot = {
  customerRef: CUSTOMER,
  planRef: PLAN,
  status: "active",
  currentPeriodStart: new Date("2026-09-07T00:00:00.000Z"),
  currentPeriodEnd: new Date("2026-10-07T00:00:00.000Z"),
  billingAnchorDay: 7,
  cancelAtPeriodEnd: false,
  hasPaymentMethod: true,
};

const WEBHOOK_BODY: MemoryWebhookPayload = {
  kind: "subscription_activated",
  eventId: "evt_0001",
  customerRef: CUSTOMER,
  occurredAt: "2026-09-07T00:00:01.000Z",
};

function makePayments(): MemoryPayments {
  return new MemoryPayments({
    subscriptions: [SUBSCRIPTION],
    plans: [PLAN],
    webhookSecret: SECRET,
  });
}

const rawBody = JSON.stringify(WEBHOOK_BODY);

describePaymentsContract({ describe, it }, "memory", {
  makeAdapter: makePayments,
  customerRef: CUSTOMER,
  planRef: PLAN,
  webhook: { rawBody, signatureHeader: makePayments().signWebhook(rawBody) },
  // Cierra la aserción de `NFR-004`, que hasta acá no tenía ninguna: llamaba
  // dos veces a `recordUsage` y no miraba nada, así que un adaptador que
  // facturara dos veces la pasaba. Se lee del adaptador que el caso construyó.
  readUsageTotal: (adapter, customerRef, meter) => adapter.usageTotal(customerRef, meter),
});

describe("MemoryPayments — comportamiento propio del adaptador", () => {
  it("con reloj congelado en el pasado emite sesiones ya vencidas", async () => {
    // La misma trampa que encontró la suite de `Storage`, y por la misma
    // razón: `checkFuture` compara contra la hora de pared porque una sesión
    // alojada la abre un navegador, no el reloj inyectado. Montar este
    // adaptador con `FixedClock` hace fallar dos aserciones del contrato, y el
    // problema está en el montaje, no en la suite.
    const pasado = new FixedClock("2020-01-01T00:00:00.000Z");
    const payments = new MemoryPayments({ clock: pasado, subscriptions: [SUBSCRIPTION] });

    const session = await payments.createBillingPortalSession({
      customerRef: CUSTOMER,
      returnUrl: "https://example.invalid/billing",
    });

    expect(session.expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it("recordUsage con la misma clave no suma dos veces (NFR-004)", async () => {
    const payments = makePayments();
    const request = {
      customerRef: CUSTOMER,
      meter: "content_save_overage",
      quantity: 1,
      occurredAt: new Date(),
      idempotencyKey: "usage-1",
    };

    await payments.recordUsage(request);
    await payments.recordUsage(request);

    // Esto es lo que `NFR-004` promete de verdad. La aserción del contrato
    // sólo puede comprobar que el reintento no lance —desde afuera de un
    // proveedor no se ve más—, y un adaptador que cuenta dos veces la pasa.
    expect(payments.usageTotal(CUSTOMER, "content_save_overage")).toBe(1);
  });

  it("claves distintas sí suman: la idempotencia no puede tragarse un uso real", async () => {
    const payments = makePayments();
    const base = {
      customerRef: CUSTOMER,
      meter: "content_save_overage",
      quantity: 2,
      occurredAt: new Date(),
    };

    await payments.recordUsage({ ...base, idempotencyKey: "a" });
    await payments.recordUsage({ ...base, idempotencyKey: "b" });

    expect(payments.usageTotal(CUSTOMER, "content_save_overage")).toBe(4);
  });

  it("createCheckout con la misma clave devuelve la misma sesión", async () => {
    const payments = makePayments();
    const request = {
      customerRef: CUSTOMER,
      planRef: PLAN,
      successUrl: "https://example.invalid/ok",
      cancelUrl: "https://example.invalid/cancel",
      idempotencyKey: "checkout-1",
    };

    const first = await payments.createCheckout(request);
    const second = await payments.createCheckout(request);

    // Un reintento no puede dejar dos checkouts abiertos para la misma alta.
    expect(second.url).toBe(first.url);
  });

  it("checkout a un plan desconocido es bad_request", async () => {
    const payments = makePayments();

    await expect(
      payments.createCheckout({
        customerRef: CUSTOMER,
        planRef: "plan_que_no_existe",
        successUrl: "https://example.invalid/ok",
        cancelUrl: "https://example.invalid/cancel",
        idempotencyKey: "checkout-2",
      }),
    ).rejects.toMatchObject({ name: "PortError", code: "bad_request" });
  });

  it("un downgrade queda programado y se puede cancelar (§16.3)", async () => {
    const payments = new MemoryPayments({
      subscriptions: [SUBSCRIPTION],
      webhookSecret: SECRET,
    });

    const programado = await payments.changePlan({
      customerRef: CUSTOMER,
      planRef: "plan_mas_chico",
      timing: "at_period_end",
      idempotencyKey: "plan-1",
    });
    expect(programado.scheduledChange?.planRef).toBe("plan_mas_chico");
    expect(programado.planRef).toBe(PLAN); // todavía no cambió

    const cancelado = await payments.cancelScheduledPlanChange(CUSTOMER);
    expect(cancelado.scheduledChange).toBeUndefined();
  });

  it("cancelar un cambio que no existe es conflict, no not_found", async () => {
    const payments = makePayments();

    // §16.3 literal: `There is no scheduled plan switch to cancel.` El cliente
    // existe; lo que no existe es el cambio.
    await expect(payments.cancelScheduledPlanChange(CUSTOMER)).rejects.toMatchObject({
      name: "PortError",
      code: "conflict",
    });
  });

  it("cambiar de plan sin suscripción activa es conflict", async () => {
    const payments = new MemoryPayments({
      subscriptions: [{ ...SUBSCRIPTION, status: "past_due" }],
    });

    await expect(
      payments.changePlan({
        customerRef: CUSTOMER,
        planRef: "otro",
        timing: "immediate_prorated",
        idempotencyKey: "plan-2",
      }),
    ).rejects.toMatchObject({ name: "PortError", code: "conflict" });
  });

  it("cancelar la suscripción deja cancelAtPeriodEnd y no borra nada (§16.5)", async () => {
    const payments = makePayments();

    const next = await payments.cancelSubscription({
      customerRef: CUSTOMER,
      feedback: "muy caro",
    });

    expect(next.cancelAtPeriodEnd).toBe(true);
    expect(next.status).toBe("active");
  });

  it("un webhook con firma válida y cuerpo ilegible es provider_contract_violation", async () => {
    const payments = makePayments();
    const roto = "esto no es json";

    // La otra mitad de la regla: firma válida ⇒ el emisor es quien dice ser,
    // así que un cuerpo que no encaja es un bug, no un ataque.
    await expect(
      payments.verifyWebhook({
        rawBody: roto,
        signatureHeader: payments.signWebhook(roto),
      }),
    ).rejects.toMatchObject({ name: "PortError", code: "provider_contract_violation" });
  });

  it("un webhook sin eventId es provider_contract_violation: no se podría deduplicar", async () => {
    const payments = makePayments();
    const sinId = JSON.stringify({ kind: "payment_succeeded", customerRef: CUSTOMER });

    await expect(
      payments.verifyWebhook({
        rawBody: sinId,
        signatureHeader: payments.signWebhook(sinId),
      }),
    ).rejects.toMatchObject({ name: "PortError", code: "provider_contract_violation" });
  });

  it("un kind que este contrato no modela se traduce a unhandled", async () => {
    const payments = makePayments();
    const raro = JSON.stringify({
      kind: "invoice.upcoming",
      eventId: "evt_9",
      customerRef: CUSTOMER,
    });

    const event = await payments.verifyWebhook({
      rawBody: raro,
      signatureHeader: payments.signWebhook(raro),
    });

    // `unhandled` existe para esto: un evento nuevo del proveedor se loguea y
    // se ignora, no tumba el endpoint.
    expect(event.kind).toBe("unhandled");
    expect(event.eventId).toBe("evt_9");
  });

  it("una firma de otra longitud no matchea y no lanza desde timingSafeEqual", async () => {
    const payments = makePayments();

    await expect(
      payments.verifyWebhook({ rawBody, signatureHeader: "corta" }),
    ).rejects.toMatchObject({ name: "PortError", code: "unauthorized" });
  });

  it("el evento trae la suscripción resultante cuando el cliente tiene una", async () => {
    const payments = makePayments();

    const event = await payments.verifyWebhook({
      rawBody,
      signatureHeader: payments.signWebhook(rawBody),
    });

    // Evita una ida extra al proveedor por el estado que el evento ya implica.
    expect(event.subscription?.planRef).toBe(PLAN);
  });
});
