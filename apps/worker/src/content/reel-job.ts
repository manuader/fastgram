/**
 * Rama `reel` del build (`PU-S9-010`, `D-20`).
 *
 * El reel no pasa por `toRenderJob`: no es uno de los cuatro formatos de
 * `FR-070` y no tiene cajas de texto de `FR-051`. Su estado editable completo
 * es el spec; el editor por capas lo reemplaza entero con
 * `PUT /content/:id/reel`, que lo guarda en `studioState.reel` sin reescribir
 * `buildPayload` (la misma regla que los swaps de media: el payload original
 * queda como estaba y la edición va encima).
 */
import {
  reelBuildPayloadSchema,
  reelMediaUrls,
  reelSpecSchema,
  type ReelSpec,
} from "@fastgram/contracts";
import type { MediaRenderer, ReelRenderer } from "@fastgram/ports";

export type ReelJobResult =
  | { readonly ok: true; readonly spec: ReelSpec; readonly urls: readonly string[] }
  | {
      readonly ok: false;
      readonly code: "invalid_build_payload" | "edit_not_renderable";
      readonly reason: string;
    };

/** Clave de `contents.studioState` donde el editor guarda el spec editado. */
export const REEL_STUDIO_STATE_KEY = "reel";

/**
 * El spec a renderizar: el editado si hay, si no el original. Un spec editado
 * que ya no valida (p. ej. cambió un tope del contrato) cierra el rebuild con
 * `edit_not_renderable`: renderizar el original declararía aplicada una
 * edición que no salió.
 */
export function reelSpecOf(buildPayload: unknown, studioState: unknown): ReelJobResult {
  const parsed = reelBuildPayloadSchema.safeParse(buildPayload);
  if (!parsed.success) {
    return {
      ok: false,
      code: "invalid_build_payload",
      reason: `buildPayload de reel no cumple el contrato: ${parsed.error.issues
        .map((i) => `${i.path.join(".")}: ${i.code}`)
        .join("; ")}`,
    };
  }
  let spec = parsed.data.reel;
  const edited =
    typeof studioState === "object" && studioState !== null
      ? (studioState as Record<string, unknown>)[REEL_STUDIO_STATE_KEY]
      : undefined;
  if (edited !== undefined && edited !== null) {
    const again = reelSpecSchema.safeParse(edited);
    if (!again.success) {
      return {
        ok: false,
        code: "edit_not_renderable",
        reason: `studioState.reel no cumple el contrato: ${again.error.issues
          .map((i) => `${i.path.join(".")}: ${i.code}`)
          .join("; ")}`,
      };
    }
    spec = again.data;
  }
  return { ok: true, spec, urls: reelMediaUrls(spec) };
}

/** El renderer montado sabe hacer reels (el HTTP sí; el de memoria no). */
export function isReelRenderer(
  renderer: MediaRenderer,
): renderer is MediaRenderer & ReelRenderer {
  return (
    typeof (renderer as Partial<ReelRenderer>).renderReel === "function" &&
    typeof (renderer as Partial<ReelRenderer>).previewReel === "function"
  );
}
