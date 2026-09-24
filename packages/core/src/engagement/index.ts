/**
 * Engagement (Reddit) — `FR-140`, `MOD-014`, `P4-ENGAGE-001…012`. Lógica pura:
 * scoring `JV-2`, ban meter `JV-5` + `DP-003` (ratio y nivel en código),
 * descubrimiento, respuesta y seguimiento del hilo. El OAuth de Reddit está en
 * `connections/reddit.ts`.
 */
export * from "./lead-scoring.js";
export * from "./ban-meter.js";
export * from "./reply.js";
export * from "./discovery.js";
export * from "./monitor.js";
export * from "./jobs.js";
export * from "./tokens.js";
