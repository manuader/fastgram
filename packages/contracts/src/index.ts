/**
 * `@fastgram/contracts` — contrato público de la API v1 · ADR-015.
 *
 * Una sola definición por request y response, en Zod. De acá salen los tipos de
 * TypeScript, la validación en runtime del API y el documento OpenAPI
 * (`buildOpenApiDocument`).
 *
 * **Este paquete es standalone.** No importa `core`, `db`, `adapters` ni
 * `ports` — la regla `contracts-are-standalone` de dependency-cruiser lo
 * enforcea. La razón: esto se publica como SDK, y si arrastrara el dominio,
 * publicarlo expondría todo el interior.
 *
 * Los enums, los caps y los rangos son **literales del PRD**. Cada número lleva
 * un test que lo fija: si mañana alguien cambia 20 slides por 25, el test grita.
 */

// Primitivas compartidas
export * from "./primitives/ids.js";
export * from "./primitives/errors.js";
export * from "./primitives/envelope.js";
export * from "./primitives/pagination.js";
export * from "./primitives/idempotency.js";
export * from "./primitives/enums.js";
export * from "./primitives/uploads.js";

// Un módulo por recurso
export * from "./resources/blitz.js";
export * from "./resources/angles.js";
export * from "./resources/influencers.js";
export * from "./resources/media.js";
export * from "./resources/content.js";
export * from "./resources/reel.js";
export * from "./resources/posts.js";
export * from "./resources/analytics.js";
export * from "./resources/connections.js";
export * from "./resources/warmed-accounts.js";
export * from "./resources/audio.js";
export * from "./resources/tiktok-sounds.js";
export * from "./resources/brand.js";
export * from "./resources/onboarding.js";
export * from "./resources/workspaces.js";
export * from "./resources/models.js";
export * from "./resources/genai.js";
// Sprint 8 (agente L): formatos con voz y character swap.
export * from "./resources/speaking.js";
export * from "./resources/strategy.js";
export * from "./resources/autopilot.js";
export * from "./resources/inspiration.js";
export * from "./resources/engagement.js";
export * from "./resources/automations.js";
export * from "./resources/notifications.js";
// Sprint 7, segunda tanda (H): oferta post-análisis y audio extraído.
export * from "./resources/brand-flow.js";
// Sprint 8 (K): biblioteca de modelos del dueño.
export * from "./resources/character-models.js";
// Sprint 9 (Q): preferencias aprendidas desde Blitz (D-22).
export * from "./resources/preferences.js";

// Sprint 9 (N): biblioteca global de assets (D-19).
export * from "./resources/library.js";

// Sprint 9 (R): anuncios pagos con Meta (D-21).
export * from "./resources/ads.js";
// Sprint 9 (M): design system por marca (`PU-S9-001…004`).
export * from "./resources/design-system.js";

// OpenAPI
export * from "./openapi.js";
