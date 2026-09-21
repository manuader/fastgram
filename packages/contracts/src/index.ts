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
export * from "./primitives/ids";
export * from "./primitives/errors";
export * from "./primitives/envelope";
export * from "./primitives/pagination";
export * from "./primitives/idempotency";
export * from "./primitives/enums";
export * from "./primitives/uploads";

// Un módulo por recurso
export * from "./resources/blitz";
export * from "./resources/angles";
export * from "./resources/influencers";
export * from "./resources/media";
export * from "./resources/content";
export * from "./resources/posts";
export * from "./resources/analytics";
export * from "./resources/connections";
export * from "./resources/warmed-accounts";
export * from "./resources/audio";
export * from "./resources/tiktok-sounds";
export * from "./resources/brand";

// OpenAPI
export * from "./openapi";
