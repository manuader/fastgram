/**
 * `Payments` en memoria — PRD `INT-008`, §16, `DATA-017`, `NFR-004`, `NFR-007`.
 *
 * **Esto no es Stripe.** `INT-008` marca el proveedor como INFERRED —«el uso
 * exacto es INFERRED»— así que el adaptador real todavía no se puede escribir
 * sin inventar. Este ocupa el mismo lugar que `MemoryStorage`: hace correr las
 * ocho aserciones de contrato sin cuenta de proveedor, y le da a `core` un
 * `Payments` que funciona para testear las reglas de §16 (cambio de plan,
 * cancelación programada, overage medido) sin tocar la red.
 *
 * **Las dos cosas que sí son lógica de verdad, porque no dependen del
 * proveedor:**
 *
 * 1. **La verificación de firma.** El esquema es HMAC-SHA256 sobre el cuerpo
 *    crudo, que es lo genérico; no es el de ningún proveedor y no pretende
 *    serlo. Lo que importa es la distinción que el contrato exige y que un
 *    adaptador descuidado pierde: **firma inválida ⇒ `unauthorized`** (alguien
 *    está falsificando) y **firma válida con payload raro ⇒
 *    `provider_contract_violation`** (bug propio). Colapsar las dos en
 *    `bad_request` hace que un intento de regalar planes se vea en el log
 *    igual que un typo.
 *
 * 2. **La idempotencia de `recordUsage`** (`NFR-004`). La aserción del
 *    contrato sólo comprueba que el segundo intento no lance, que es lo único
 *    que se puede verificar contra un proveedor real desde afuera. Acá, como
 *    el ledger es propio, {@link MemoryPayments.usageTotal} deja además
 *    comprobar que **no contó dos veces** — que es lo que `NFR-004` promete de
 *    verdad y lo que en producción se descubre por soporte.
 *
 * **Lo que deliberadamente NO hay:** precios, nombres de plan, prorrateo,
 * comisiones, ni ningún número de §16.1. Los planes son strings opacos que
 * siembra quien construye el adaptador, y los montos no existen: este puerto
 * no los maneja. Tampoco hay un solo campo con forma de proveedor, que es
 * justamente lo que `DATA-017` prohíbe dejar escapar.
 */

import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import {
  PortError,
  type BillingPortalRequest,
  type CancelSubscriptionRequest,
  type ChangePlanRequest,
  type Clock,
  type CreateCheckoutRequest,
  type HostedSession,
  type PaymentCustomerRef,
  type PaymentEvent,
  type PaymentEventKind,
  type PaymentPlanRef,
  type Payments,
  type RecordUsageRequest,
  type SubscriptionSnapshot,
  type VerifyWebhookRequest,
} from "@fastgram/ports";
import { systemClock } from "../clock/index.js";

const SOURCE = "Payments/memory";

/**
 * Vida de una sesión alojada. Una hora es el default de este adaptador: §16 no
 * fija ningún vencimiento y no hay proveedor de dónde sacarlo.
 */
const DEFAULT_HOSTED_TTL_SECONDS = 3600;

/** Secreto por defecto de la firma. Es de juguete y se ve que lo es. */
const DEFAULT_WEBHOOK_SECRET = "memory-webhook-secret";

const KNOWN_EVENT_KINDS: readonly PaymentEventKind[] = [
  "subscription_activated",
  "subscription_updated",
  "subscription_canceled",
  "payment_succeeded",
  "payment_failed",
];

export interface MemoryPaymentsOptions {
  readonly clock?: Clock;
  /** Suscripciones ya existentes. Un cliente ausente es plan Free (§16.1). */
  readonly subscriptions?: readonly SubscriptionSnapshot[];
  /** Planes a los que se puede hacer checkout. Vacío ⇒ se acepta cualquiera. */
  readonly plans?: readonly PaymentPlanRef[];
  readonly webhookSecret?: string;
  readonly hostedTtlSeconds?: number;
  /**
   * Base de las URLs alojadas. `.invalid` a propósito (RFC 2606): si un test
   * llegara a abrirla, tiene que fallar en vez de salir a internet.
   */
  readonly hostedBaseUrl?: string;
}

/** Lo que se firma y se manda como cuerpo del webhook sintético. */
export interface MemoryWebhookPayload {
  readonly kind: string;
  readonly eventId: string;
  readonly customerRef: PaymentCustomerRef;
  /** ISO-8601. Si falta, se usa la hora del reloj al verificar. */
  readonly occurredAt?: string;
}

interface UsageEntry {
  readonly customerRef: PaymentCustomerRef;
  readonly meter: string;
  readonly quantity: number;
}

export class MemoryPayments implements Payments {
  readonly #clock: Clock;
  readonly #subscriptions = new Map<PaymentCustomerRef, SubscriptionSnapshot>();
  readonly #plans: ReadonlySet<PaymentPlanRef>;
  readonly #secret: string;
  readonly #ttlSeconds: number;
  readonly #baseUrl: string;
  /** `idempotencyKey` → uso ya contado. Es el ledger de `NFR-004`. */
  readonly #usage = new Map<string, UsageEntry>();
  /** `idempotencyKey` → sesión ya creada. Reintentar no crea dos checkouts. */
  readonly #checkouts = new Map<string, HostedSession>();

  constructor(options: MemoryPaymentsOptions = {}) {
    this.#clock = options.clock ?? systemClock;
    this.#plans = new Set(options.plans ?? []);
    this.#secret = options.webhookSecret ?? DEFAULT_WEBHOOK_SECRET;
    this.#ttlSeconds = options.hostedTtlSeconds ?? DEFAULT_HOSTED_TTL_SECONDS;
    this.#baseUrl = options.hostedBaseUrl ?? "https://billing.invalid";
    for (const subscription of options.subscriptions ?? []) {
      this.#subscriptions.set(subscription.customerRef, subscription);
    }
  }

  async createCheckout(request: CreateCheckoutRequest): Promise<HostedSession> {
    if (request.idempotencyKey.length === 0) {
      throw new PortError("bad_request", "idempotencyKey is required", {
        source: SOURCE,
      });
    }
    const existing = this.#checkouts.get(request.idempotencyKey);
    if (existing !== undefined) return existing;

    if (this.#plans.size > 0 && !this.#plans.has(request.planRef)) {
      throw new PortError("bad_request", "unknown plan", { source: SOURCE });
    }
    assertAbsoluteUrl(request.successUrl, "successUrl");
    assertAbsoluteUrl(request.cancelUrl, "cancelUrl");

    const session: HostedSession = {
      url: `${this.#baseUrl}/checkout/${randomUUID()}`,
      expiresAt: this.#expiry(),
    };
    this.#checkouts.set(request.idempotencyKey, session);
    return session;
  }

  async createBillingPortalSession(
    request: BillingPortalRequest,
  ): Promise<HostedSession> {
    assertAbsoluteUrl(request.returnUrl, "returnUrl");
    // §16.4: el portal es del proveedor y el producto sólo abre la puerta. No
    // se devuelve ni un dato de pago porque acá no hay ninguno: esos datos no
    // entran nunca al sistema.
    return { url: `${this.#baseUrl}/portal/${randomUUID()}`, expiresAt: this.#expiry() };
  }

  async getSubscription(
    customerRef: PaymentCustomerRef,
  ): Promise<SubscriptionSnapshot | null> {
    // `null` y no excepción: §16.1 tiene un plan Free que no tiene suscripción.
    return this.#subscriptions.get(customerRef) ?? null;
  }

  async changePlan(request: ChangePlanRequest): Promise<SubscriptionSnapshot> {
    const current = this.#require(request.customerRef);
    if (this.#plans.size > 0 && !this.#plans.has(request.planRef)) {
      throw new PortError("bad_request", "unknown plan", { source: SOURCE });
    }
    if (current.status !== "active" && current.status !== "trialing") {
      // §16.3 literal: «Plan switching is available once your subscription is
      // active». `conflict`, no `bad_request`: el pedido está bien formado, es
      // el estado el que no lo admite.
      throw new PortError("conflict", "plan switching needs an active subscription", {
        source: SOURCE,
      });
    }

    const next: SubscriptionSnapshot =
      request.timing === "immediate_prorated"
        ? { ...withoutScheduledChange(current), planRef: request.planRef }
        : {
            ...current,
            scheduledChange: {
              planRef: request.planRef,
              effectiveAt: current.currentPeriodEnd,
            },
          };
    this.#subscriptions.set(next.customerRef, next);
    return next;
  }

  async cancelScheduledPlanChange(
    customerRef: PaymentCustomerRef,
  ): Promise<SubscriptionSnapshot> {
    const current = this.#require(customerRef);
    if (current.scheduledChange === undefined) {
      // §16.3 literal: `There is no scheduled plan switch to cancel.`
      throw new PortError("conflict", "there is no scheduled plan switch to cancel", {
        source: SOURCE,
      });
    }
    const next = withoutScheduledChange(current);
    this.#subscriptions.set(customerRef, next);
    return next;
  }

  async cancelSubscription(
    request: CancelSubscriptionRequest,
  ): Promise<SubscriptionSnapshot> {
    const current = this.#require(request.customerRef);
    // §16.5: efectiva a fin de periodo. El feedback se ignora acá, y sobre
    // todo **no puede impedir la cancelación**: `Cancellation feedback
    // submission failed:` es un aviso, no un bloqueo.
    const next: SubscriptionSnapshot = { ...current, cancelAtPeriodEnd: true };
    this.#subscriptions.set(request.customerRef, next);
    return next;
  }

  async recordUsage(request: RecordUsageRequest): Promise<void> {
    if (!Number.isFinite(request.quantity) || request.quantity <= 0) {
      throw new PortError("bad_request", "quantity must be positive", { source: SOURCE });
    }
    if (request.idempotencyKey.length === 0) {
      throw new PortError("bad_request", "idempotencyKey is required", {
        source: SOURCE,
      });
    }
    // Ya contado: se vuelve sin lanzar. Un reintento de red es normal; lo que
    // no puede es sumar dos veces (`NFR-004`).
    if (this.#usage.has(request.idempotencyKey)) return;

    this.#usage.set(request.idempotencyKey, {
      customerRef: request.customerRef,
      meter: request.meter,
      quantity: request.quantity,
    });
  }

  async verifyWebhook(request: VerifyWebhookRequest): Promise<PaymentEvent> {
    if (!this.#signatureMatches(request.rawBody, request.signatureHeader)) {
      // `unauthorized` y no `bad_request`: esto es un intento de falsificación
      // y tiene que poder distinguirse de un bug propio en el log.
      throw new PortError("unauthorized", "invalid webhook signature", {
        source: SOURCE,
      });
    }

    const payload = parsePayload(request.rawBody);
    const kind: PaymentEventKind = isKnownKind(payload.kind) ? payload.kind : "unhandled";
    const occurredAt =
      payload.occurredAt === undefined ? this.#clock.now() : new Date(payload.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new PortError("provider_contract_violation", "occurredAt is not a date", {
        source: SOURCE,
      });
    }

    const subscription = this.#subscriptions.get(payload.customerRef);
    return {
      kind,
      eventId: payload.eventId,
      customerRef: payload.customerRef,
      occurredAt,
      ...(subscription === undefined ? {} : { subscription }),
    };
  }

  /** Firma un cuerpo con el mismo esquema que verifica. Para armar fixtures. */
  signWebhook(rawBody: string): string {
    return createHmac("sha256", this.#secret).update(rawBody).digest("hex");
  }

  /** Sólo para tests: cuánto se contó de verdad para un cliente y medidor. */
  usageTotal(customerRef: PaymentCustomerRef, meter: string): number {
    let total = 0;
    for (const entry of this.#usage.values()) {
      if (entry.customerRef === customerRef && entry.meter === meter) {
        total += entry.quantity;
      }
    }
    return total;
  }

  #signatureMatches(rawBody: string, signatureHeader: string): boolean {
    const expected = Buffer.from(this.signWebhook(rawBody), "utf8");
    const actual = Buffer.from(signatureHeader, "utf8");
    // Longitudes distintas ya no matchean, y `timingSafeEqual` lanza si no
    // coinciden: hay que cortar antes, sin filtrar la longitud real.
    if (expected.length !== actual.length) return false;
    return timingSafeEqual(expected, actual);
  }

  #require(customerRef: PaymentCustomerRef): SubscriptionSnapshot {
    const current = this.#subscriptions.get(customerRef);
    if (current === undefined) {
      throw new PortError("not_found", "no subscription for this customer", {
        source: SOURCE,
      });
    }
    return current;
  }

  #expiry(): Date {
    return new Date(this.#clock.nowMs() + this.#ttlSeconds * 1000);
  }
}

function withoutScheduledChange(
  subscription: SubscriptionSnapshot,
): SubscriptionSnapshot {
  // `exactOptionalPropertyTypes` no deja poner `scheduledChange: undefined`,
  // así que la forma de quitarlo es desestructurar.
  const { scheduledChange: _removed, ...rest } = subscription;
  return rest;
}

function parsePayload(rawBody: string): MemoryWebhookPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    // Firma válida y cuerpo ilegible: el que se equivocó fue el emisor, no
    // quien lo mandó. Es la mitad `provider_contract_violation` de la regla.
    throw new PortError("provider_contract_violation", "webhook body is not JSON", {
      source: SOURCE,
    });
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new PortError("provider_contract_violation", "webhook body is not an object", {
      source: SOURCE,
    });
  }
  const payload = parsed as Partial<MemoryWebhookPayload>;
  if (
    typeof payload.kind !== "string" ||
    typeof payload.eventId !== "string" ||
    payload.eventId.length === 0 ||
    typeof payload.customerRef !== "string" ||
    payload.customerRef.length === 0
  ) {
    // Sin `eventId` no se puede deduplicar una reentrega, y sin `customerRef`
    // el evento no se puede aplicar a nadie. Un webhook así es inservible.
    throw new PortError(
      "provider_contract_violation",
      "webhook is missing eventId or customerRef",
      { source: SOURCE },
    );
  }
  return {
    kind: payload.kind,
    eventId: payload.eventId,
    customerRef: payload.customerRef,
    ...(payload.occurredAt === undefined ? {} : { occurredAt: payload.occurredAt }),
  };
}

function isKnownKind(kind: string): kind is PaymentEventKind {
  return (KNOWN_EVENT_KINDS as readonly string[]).includes(kind);
}

function assertAbsoluteUrl(value: string, field: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PortError("bad_request", `${field} must be an absolute URL`, {
      source: SOURCE,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new PortError("bad_request", `${field} must be an absolute URL`, {
      source: SOURCE,
    });
  }
}
