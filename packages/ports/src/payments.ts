/**
 * Puerto Payments — PRD `INT-008`, §16, `DATA-017`, `NFR-007`.
 *
 * Qué lo obliga, en orden de fuerza:
 *
 *  1. `INT-008` marca el proveedor como **INFERRED**: «Evidencia indirecta
 *     fuerte … el uso exacto es INFERRED». El PRD no sabe con certeza qué
 *     hace Stripe en el original. Escribir un SDK dentro del dominio a partir
 *     de una inferencia es exactamente lo que IMPL §7 llama sobre-ingeniería
 *     al revés: comprometerse con lo que todavía no se verificó.
 *  2. `DATA-017` dice que los **«campos de Stripe»** están entre los campos
 *     internos que **nunca** se exponen, junto con ids de proveedor y secretos
 *     de provisión. `NFR-007` lo generaliza. Un puerto es el sitio donde esa
 *     regla se puede verificar de una vez: si el tipo que cruza la frontera no
 *     tiene forma de proveedor, no hay manera de filtrarlo por descuido.
 *  3. §16.4: `Manage Billing` abre **el portal externo del proveedor**. El
 *     producto no implementa gestión de medios de pago; delega. Por eso acá
 *     hay `createBillingPortalSession` y **no hay ningún método que reciba
 *     datos de tarjeta**: esos datos no entran nunca al sistema.
 *
 * Errores (`PortError`):
 *  - `provider_unavailable`, `timeout`, `rate_limited` — `Couldn't start
 *    checkout` (§16.4) sale de acá.
 *  - `unauthorized` — credenciales del proveedor. No cruza al cliente.
 *  - `not_found` — cliente o suscripción desconocidos.
 *  - `conflict` — §16.3: «Plan switching is available once your subscription
 *    is active», y `There is no scheduled plan switch to cancel.`
 *  - `bad_request` — plan inexistente, cantidad negativa en `recordUsage`.
 *  - `provider_contract_violation` — webhook con firma válida pero payload que
 *    no encaja. **Un webhook con firma inválida es `unauthorized`**, y hay que
 *    poder distinguirlos: uno es un bug, el otro un intento de falsificación.
 *
 * Lo que este puerto NO hace: no conoce las cuotas de §16.2 (content saves,
 * swipes, créditos: eso es `core` + `QuotaLedger`), no decide precios —§16
 * los toma literales de la página oficial y `OQ-07` sigue abierto sobre los
 * anuales— y no hace aritmética de prorrateo: la hace el proveedor y el
 * resultado se lee.
 */

/**
 * Identificador del cliente **en el proveedor**. Opaco: el dominio lo guarda
 * junto a la `Company` y no lo interpreta jamás. `NFR-007` / `DATA-017`
 * prohíben devolverlo por la API.
 */
export type PaymentCustomerRef = string;

/**
 * Identificador de plan en el proveedor. El nombre comercial (`Free`,
 * `Starter`, `Growth`, `Pro` de §16.1) es del dominio y no se mezcla con esto.
 */
export type PaymentPlanRef = string;

/**
 * Estados neutrales de suscripción.
 *
 * **Divergencia conocida y sin decidir:** `incomplete` no existe en
 * `Workspace.subscriptionStatus` del PRD (`DATA-002`: `trialing | active |
 * past_due | canceled`) ni, por lo tanto, en el enum `subscription_status` de
 * Postgres. Si alguien persiste este estado tal cual, la base lo rechaza.
 * `scripts/check-consistency.mjs` fija la diferencia en exactamente
 * `incomplete` para que no crezca sin que nadie lo vea; resolverla (mapearlo al
 * persistir, o sumarlo al PRD y a la base) es una decisión pendiente.
 */
export const SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  /** §9.7: un workspace de Partner en `past_due` sigue teniendo capacidades. */
  "past_due",
  "canceled",
  /** §16.3: «Sort out your billing first and this will open back up». */
  "incomplete",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface ScheduledPlanChange {
  readonly planRef: PaymentPlanRef;
  readonly effectiveAt: Date;
}

export interface SubscriptionSnapshot {
  readonly customerRef: PaymentCustomerRef;
  readonly planRef: PaymentPlanRef;
  readonly status: SubscriptionStatus;
  readonly currentPeriodStart: Date;
  /** §16.4: `Next Billing Date`. */
  readonly currentPeriodEnd: Date;
  /**
   * Día del mes del ancla de facturación. §16.2 resetea los content saves «día
   * ancla de facturación, 00:00 UTC», y sin este número ese reset no se puede
   * programar.
   */
  readonly billingAnchorDay: number;
  /** §16.7: el trial allowance es de por vida y no resetea. */
  readonly trialEndsAt?: Date;
  /** §16.3: downgrade programado, cancelable. */
  readonly scheduledChange?: ScheduledPlanChange;
  /** §16.5: `Cancellation pending`. */
  readonly cancelAtPeriodEnd: boolean;
  /** §16.3: sin esto el upgrade se bloquea con copy propio. */
  readonly hasPaymentMethod: boolean;
}

export interface CreateCheckoutRequest {
  readonly customerRef: PaymentCustomerRef;
  readonly planRef: PaymentPlanRef;
  readonly successUrl: string;
  readonly cancelUrl: string;
  /** `NFR-004`: reintentar no puede crear dos suscripciones. */
  readonly idempotencyKey: string;
}

export interface HostedSession {
  readonly url: string;
  readonly expiresAt: Date;
}

export interface BillingPortalRequest {
  readonly customerRef: PaymentCustomerRef;
  readonly returnUrl: string;
}

export interface ChangePlanRequest {
  readonly customerRef: PaymentCustomerRef;
  readonly planRef: PaymentPlanRef;
  /**
   * §16.3. `immediate_prorated` es el upgrade (`Plan upgrade (pro-rated)`);
   * `at_period_end` es el downgrade (`Plan downgrade adjustment`), que queda
   * programado y se puede cancelar.
   */
  readonly timing: "immediate_prorated" | "at_period_end";
  readonly idempotencyKey: string;
}

export interface CancelSubscriptionRequest {
  readonly customerRef: PaymentCustomerRef;
  /**
   * §16.5: el flujo pide feedback antes de confirmar. Se pasa al proveedor
   * cuando lo admite; si no, quien llama lo guarda. `Cancellation feedback
   * submission failed:` **no** debe impedir la cancelación.
   */
  readonly feedback?: string;
}

export interface RecordUsageRequest {
  readonly customerRef: PaymentCustomerRef;
  /**
   * §16.6: hoy sólo existe el `user API content-save overage` medido. Se deja
   * como string porque el catálogo de métricas facturables no está cerrado en
   * el PRD.
   */
  readonly meter: string;
  readonly quantity: number;
  readonly occurredAt: Date;
  /** Obligatoria: sin esto un reintento factura dos veces (`NFR-004`). */
  readonly idempotencyKey: string;
}

/**
 * Eventos neutrales. El webhook crudo del proveedor **no** sale del adaptador:
 * es lo que permite que cambiar de proveedor no reescriba el consumidor.
 */
export type PaymentEventKind =
  | "subscription_activated"
  | "subscription_updated"
  | "subscription_canceled"
  | "payment_succeeded"
  | "payment_failed"
  /** Eventos que este contrato no modela. Se loguean y se ignoran. */
  | "unhandled";

export interface PaymentEvent {
  readonly kind: PaymentEventKind;
  /** Id del evento en el proveedor, para deduplicar reentregas. */
  readonly eventId: string;
  readonly customerRef: PaymentCustomerRef;
  readonly occurredAt: Date;
  /** Estado resultante, cuando el evento lo trae. Evita una ida extra. */
  readonly subscription?: SubscriptionSnapshot;
}

export interface VerifyWebhookRequest {
  /** Cuerpo **crudo**, sin parsear: la firma se calcula sobre los bytes. */
  readonly rawBody: string;
  readonly signatureHeader: string;
}

export interface Payments {
  /** §16.3: alta y upgrade pasan por el checkout alojado del proveedor. */
  createCheckout(request: CreateCheckoutRequest): Promise<HostedSession>;

  /** §16.4 `Manage Billing`. Es donde el usuario gestiona su medio de pago. */
  createBillingPortalSession(request: BillingPortalRequest): Promise<HostedSession>;

  /** `null` si el cliente no tiene suscripción (plan Free de §16.1). */
  getSubscription(customerRef: PaymentCustomerRef): Promise<SubscriptionSnapshot | null>;

  changePlan(request: ChangePlanRequest): Promise<SubscriptionSnapshot>;

  /** §16.3: `There is no scheduled plan switch to cancel.` ⇒ `conflict`. */
  cancelScheduledPlanChange(
    customerRef: PaymentCustomerRef,
  ): Promise<SubscriptionSnapshot>;

  /** §16.5. Efectiva a fin de periodo: deja `cancelAtPeriodEnd: true`. */
  cancelSubscription(request: CancelSubscriptionRequest): Promise<SubscriptionSnapshot>;

  /** §16.6: overage medido de content saves por API. */
  recordUsage(request: RecordUsageRequest): Promise<void>;

  /**
   * Verifica la firma y traduce. Firma inválida ⇒ `unauthorized`; nunca se
   * procesa un webhook sin verificar.
   */
  verifyWebhook(request: VerifyWebhookRequest): Promise<PaymentEvent>;
}
