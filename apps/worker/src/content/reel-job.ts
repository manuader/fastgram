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
import { canonicalObjectUrl } from "@fastgram/adapters";
import {
  reelBuildPayloadSchema,
  reelFontUrls,
  reelMediaUrls,
  reelSpecSchema,
  type ReelSpec,
} from "@fastgram/contracts";
import type {
  MediaAuthorization,
  MediaRenderer,
  ReelRenderer,
  Storage,
} from "@fastgram/ports";

import { usesGlobalLibrary, withGlobalLibrary } from "../library/authorization.js";
import { workspaceMediaAuthorization } from "./media-authorization.js";

export type ReelJobResult =
  | {
      readonly ok: true;
      readonly spec: ReelSpec;
      readonly urls: readonly string[];
      /** Sprint 9 (U): las caras de marca (`fonts/{companyId}/`), aparte de la media. */
      readonly fontUrls: readonly string[];
    }
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
  return { ok: true, spec, urls: reelMediaUrls(spec), fontUrls: reelFontUrls(spec) };
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

/**
 * El grant de un reel — sprint 9 (U), `PU-S9-014`. El de siempre
 * (`workspaceMediaAuthorization`: prefijos del workspace + la URL exacta de
 * cada asset) más lo que un reel del planificador puede traer:
 *
 *  - las **fuentes de marca** del design system (`fonts/{companyId}/`, donde
 *    M las sube), con cada URL listada;
 *  - la **biblioteca global** (`library/`, D-19) si algún asset es de ahí
 *    (`withGlobalLibrary` de N: va en `sharedPrefixes`, así sirve también
 *    para la música).
 *
 * Lo usan el build del reel y el póster del planificador: un solo grant, así
 * lo que se vio en la tarjeta es lo que se puede renderizar.
 */
export async function reelMediaAuthorization(
  storage: Storage,
  input: {
    readonly companyId: string;
    readonly objectPrefix: string;
    readonly urls: readonly string[];
    readonly fontUrls: readonly string[];
  },
): Promise<MediaAuthorization> {
  const base = await workspaceMediaAuthorization(storage, {
    companyId: input.companyId,
    objectPrefix: input.objectPrefix,
    urls: [...new Set([...input.urls, ...input.fontUrls])],
  });
  let auth: MediaAuthorization = base;
  if (input.fontUrls.length > 0) {
    // Con barra final, como el resto: `fonts/ws-1/` no matchea `fonts/ws-10/`.
    const fonts = await canonicalObjectUrl(storage, `fonts/${input.companyId}/`);
    if (!auth.mediaPrefixes.includes(fonts)) {
      auth = { ...auth, mediaPrefixes: [...auth.mediaPrefixes, fonts] };
    }
  }
  if (await usesGlobalLibrary(storage, input.urls)) {
    auth = await withGlobalLibrary(storage, auth);
  }
  return auth;
}
