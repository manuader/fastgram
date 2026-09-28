/**
 * Pesos y umbrales del decisor — en código, versionados (§9.15.3.2).
 *
 * Cambiar un peso **no** reinfiere: `asset_decisions` guarda las respuestas
 * crudas por dimensión, y `decideAsset` recalcula con los pesos nuevos. Por
 * eso cada decisión guarda `weightsVersion`: una fila de `s9.1` recalculada
 * con `s9.2` se sabe recalculada.
 *
 * ## Los números (decisión que el PRD no cubre)
 *
 * - Encaje con la idea pesa más que todo: es lo que el usuario pidió.
 * - La relevancia textual (`text`) es un ancla chica: ver `ASSET_WEIGHTS`.
 * - En memes, el remate pesa casi como la idea: un clip on-topic que no se lee
 *   sin sonido no sirve como reacción.
 * - La marca pesa menos en fondos y música (casi todo fondo es «neutral» para
 *   una marca) y más en personajes (el personaje **es** la marca en pantalla).
 * - Seguridad: `HARM_MAX` = 0,5 y `NSFW_MAX` = 0,9, medidos contra Laya (ver
 *   `HARM_QUESTION` en `questions.ts`). El de NSFW va alto porque en castellano
 *   da falsos positivos hasta 0,82 (un oficinista cansado); con 0,75 ese clip
 *   —el mejor para «odiar los lunes»— quedaba fuera. Se eligió no descartar
 *   lo inocuo: los umbrales atrapan lo explícito y **no** son un guardrail
 *   completo — ver el reporte.
 */
import type { AssetRole } from "./formats.js";
import type { AssetDimension } from "./questions.js";

export const ASSET_WEIGHTS_VERSION = "s9.1";

/**
 * Pesos por dimensión juzgada, más `text`: la relevancia textual del ranking
 * de siempre (`discovery/relevance.ts`), normalizada contra la mejor de la
 * shortlist. No se infiere: es código, y entra en la misma suma.
 */
export type DimensionWeights = Readonly<Partial<Record<AssetDimension | "text", number>>>;

/**
 * `text` pesa 0,15–0,2 por lo que se midió contra Laya (sprint 9): con una
 * idea en castellano, el checkpoint multilingüe devolvió encajes casi planos
 * (2,35–3,09 sobre 4 para 24 clips, con «un atardecer» arriba de «oficinista
 * agotado un lunes»). Sin un ancla, un juicio que no discrimina elige al azar;
 * con ella, cuando el juicio no separa gana lo que el ranking ya sabía, y
 * cuando separa (en inglés separó: 1,22–3,26) gana el juicio.
 */
export const ASSET_WEIGHTS: Readonly<Record<AssetRole, DimensionWeights>> = {
  meme: { ideaFit: 0.4, punchline: 0.3, brandFit: 0.15, text: 0.15 },
  background: { ideaFit: 0.5, brandFit: 0.3, text: 0.2 },
  video: { ideaFit: 0.5, brandFit: 0.3, text: 0.2 },
  image: { ideaFit: 0.45, brandFit: 0.35, text: 0.2 },
  music: { ideaFit: 0.45, brandFit: 0.35, text: 0.2 },
  character: { ideaFit: 0.35, brandFit: 0.5, text: 0.15 },
};

/** Umbrales duros de seguridad: con cualquiera de los dos, el candidato queda fuera. */
export const HARM_MAX = 0.5;
export const NSFW_MAX = 0.9;

/**
 * Dos totales a menos de esto son un empate y gana el mejor del ranking
 * textual. Laya redondea a 4 decimales: por debajo de 1e-3 la diferencia es
 * ruido de redondeo, no preferencia.
 */
export const TIE_EPSILON = 1e-3;
