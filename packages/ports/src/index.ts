export * from "./errors.js";
export type { Clock } from "./clock.js";
export type { Rng } from "./rng.js";

export * from "./judgment.js";
export * from "./llm.js";
export * from "./storage.js";
export * from "./queue.js";
export * from "./ocr.js";
export * from "./asr.js";
export * from "./social-reader.js";
export * from "./social-publisher.js";
export * from "./social-metrics.js";
export * from "./payments.js";
export * from "./identity.js";
export * from "./media-generation.js";
export * from "./media-renderer.js";
export * from "./brand-background.js";
export * from "./model-registry.js";
export * from "./oauth.js";
export * from "./integrations.js";
export * from "./public-media.js";
export * from "./media-import.js";
export * from "./background-removal.js";
export * from "./image-gen.js";
export * from "./video-gen.js";
// Sprint 8 (agente L): voz, talking avatar y character swap sobre fal.
export * from "./speech.js";
export * from "./talking-avatar.js";
export * from "./character-swap.js";
// Sprint 9 (agente R): ads con la Marketing API de Meta (D-21).
export * from "./ads.js";

/**
 * Suites de contrato de puerto.
 *
 * Se reexportan desde el índice —y no por un subpath `@fastgram/ports/testing`—
 * porque el `exports` del `package.json` sólo publica `.`, y tocar ese archivo
 * está fuera del alcance de esta tarea. Si más adelante molesta que el código
 * de producción pueda importarlas, el arreglo es un subpath, no moverlas.
 */
export * from "./testing/index.js";
