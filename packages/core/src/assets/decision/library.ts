/**
 * La biblioteca global como candidatos del decisor — sprint 9 (T),
 * `PU-S9-015`, D-19.
 *
 * `listLibraryCandidates` (N, `@fastgram/db`) trae las filas `ready` del tipo
 * pedido; esto las convierte en {@link AssetCandidate} con `source: "library"`.
 * El filtro por licencia **no** está acá: lo hace `exclusionFor` (O) para todo
 * candidato `library`, así que una fila con licencia no verificable llega,
 * queda excluida con motivo `license` y eso se ve en `asset_decisions`.
 *
 * ## Qué tipo de la biblioteca sirve para qué rol
 *
 * Por **formato de pieza** (`libraryKindsForFormat` de N: `video`, `carousel`,
 * `static`) y después por rol, con los tipos de asset de O. El green-screen de
 * Blitz es un video: pide `libraryKindsForFormat("video")` y de ahí el meme
 * toma los `green_screen_video` y el fondo los `background_*`.
 *
 * ## Sólo croma verde en el meme de un green-screen (decisión que el PRD no cubre)
 *
 * El green-screen clásico recorta **verde** (`services/render`, ffmpeg
 * `chromakey` sobre `#00FF00`, igual que la preview del deck). Un clip de la
 * biblioteca con croma azul o con alfa saldría con el fondo pegado. Hasta que
 * el render clásico sepa de otros croma, esos clips no compiten por el meme
 * (sí los usa el motor de reels, que tiene su propio camino).
 */
import {
  describeLibraryAsset,
  libraryKindsForFormat,
  type LibraryKind,
  type LibraryMetadataLike,
  type LibraryPieceFormat,
} from "../../library/metadata.js";
import type { AssetRole, DecisionFormat } from "./formats.js";
import { roleNeeds } from "./formats.js";
import type { AssetAspect, AssetCandidate, AssetKind } from "./types.js";

/** La fila de `library_assets` que hace falta (estructural: `LibraryAssetRow` pasa). */
export interface LibraryCandidateRow {
  readonly id: string;
  readonly kind: string;
  readonly title: string;
  readonly licenseType: string;
  readonly durationSec: number | null;
  /** Ya validada con el schema de contracts; `null` si no parsea. */
  readonly metadata: LibraryMetadataLike | null;
}

const KIND_OF: Readonly<Record<LibraryKind, AssetKind>> = {
  green_screen_video: "meme_clip",
  background_video: "background_video",
  background_image: "background_image",
  image: "image",
  audio: "audio",
};

const ASPECTS: readonly AssetAspect[] = ["9:16", "16:9", "1:1", "4:5"];

/** Qué formato de pieza de la biblioteca es cada formato del decisor. */
const PIECE_FORMAT: Readonly<Record<DecisionFormat, LibraryPieceFormat>> = {
  video: "video",
  "green-screen": "video",
  "wall-of-text": "video",
  "video-hook": "video",
  carousel: "carousel",
  slideshow: "carousel",
  static: "static",
};

/**
 * Los tipos de la biblioteca que pedirle a la base para un rol de un formato:
 * los de `libraryKindsForFormat` (N) que además son de una clase que el rol
 * acepta (O). Vacío = la biblioteca no aporta a ese rol.
 */
export function libraryKindsForRole(
  format: DecisionFormat,
  role: AssetRole,
): readonly LibraryKind[] {
  const needs = roleNeeds(format, role);
  if (needs === null) return [];
  return libraryKindsForFormat(PIECE_FORMAT[format]).filter((k) =>
    needs.kinds.includes(KIND_OF[k]),
  );
}

/**
 * Una fila de la biblioteca como candidato, o `null` si no sirve para el rol
 * (tipo desconocido, sin metadatos, o un meme de green-screen que no es de
 * croma verde: ver la cabecera).
 */
export function libraryAssetCandidate(
  row: LibraryCandidateRow,
  context: { readonly format: DecisionFormat; readonly role: AssetRole },
): AssetCandidate | null {
  if (!(row.kind in KIND_OF)) return null;
  const kind = KIND_OF[row.kind as LibraryKind];
  const meta = row.metadata;
  if (meta === null) return null;
  if (
    context.format === "green-screen" &&
    context.role === "meme" &&
    meta.chroma.type !== "green"
  ) {
    return null;
  }
  const ratio = meta.aspect.ratio;
  const aspect = (ASPECTS as readonly string[]).includes(ratio)
    ? (ratio as AssetAspect)
    : null;
  const tags = [...meta.tags, ...meta.emotions].map((t) => t.replace(/_/g, " "));
  const emotion = meta.emotions.join(" ");
  const situation = [meta.description, ...meta.useCases].join(" ").trim().slice(0, 600);
  return {
    id: row.id,
    kind,
    source: "library",
    description: describeLibraryAsset(meta, row.title),
    tags,
    durationSec: row.durationSec ?? meta.durationSec,
    aspect,
    license: row.licenseType,
    mediaSource: "library",
    relevance: {
      title: row.title,
      emotion: emotion === "" ? null : emotion,
      situation: situation === "" ? null : situation,
      tags,
    },
  };
}
