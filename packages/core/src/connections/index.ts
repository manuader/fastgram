/**
 * Conexiones sociales por marca — `PU-PUB-001`, `PU-PUB-002`, `P3-OAUTH-002`,
 * `P3-OAUTH-008`. Lógica pura; el I/O está en `packages/adapters/src/{oauth,integrations,crypto}`
 * y en `packages/db/src/repositories/connections.ts`.
 */
export * from "./platforms.js";
export * from "./state.js";
export * from "./integrations.js";
export * from "./tokens.js";
