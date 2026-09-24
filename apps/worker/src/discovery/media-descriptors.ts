/**
 * Lo que describe a cada asset del Media Bank, para elegirlo por tema —
 * sprint 7 (`JV-6`, memes desde un prompt).
 *
 * `listPlanningMedia` trae id, tipo, URL y categorías: alcanza para sortear,
 * no para elegir. Esto le suma a cada asset:
 *
 *  - **el título**: el nombre de archivo (un import por link lo arma con el
 *    título del sitio, `importFilename`);
 *  - **las etiquetas del clip** (`PU-MEME-003`): viven en un JSON por clip en
 *    el storage (`media-meta/<companyId>/<mediaId>.json`, ver
 *    `core/media-import`), no en la base;
 *  - **las etiquetas de la fila** (`media.tags`, migración `0029` del sprint
 *    7): si el clip las tiene, cuentan como tags;
 *  - **si lo encontró la búsqueda automática** (etiqueta `auto-found`).
 *
 * ## Costo
 *
 * Una consulta para los nombres y una lectura del storage **por video** con
 * categoría (las etiquetas sólo existen para videos importados). Con el
 * `PLANNING_META_READS` como tope: un Media Bank de 500 clips no convierte un
 * relleno en 500 GETs. Pasado el tope, el resto compite sólo con su título.
 *
 * Todo es de mejor esfuerzo: un JSON que no está o no parsea es un asset sin
 * etiquetas, nunca un relleno fallido.
 */
import { mediaMetaKey, parseClipTags, type PlanningMedia } from "@fastgram/core";
import { mediaRepository, type Transaction } from "@fastgram/db";
import type { Storage } from "@fastgram/ports";

import { readJsonObject } from "../media-import/status-store.js";

/** Etiqueta de la fila que marca un meme que encontró «crear desde prompt». */
export const AUTO_FOUND_TAG = "auto-found";

/** Tope de lecturas de metadata del storage por relleno. */
export const PLANNING_META_READS = 60;

/** Las lecturas del storage en paralelo, de a pocas. */
const META_CONCURRENCY = 8;

export async function describePlanningMedia(
  tx: Transaction,
  storage: Storage | undefined,
  companyId: string,
  items: readonly PlanningMedia[],
): Promise<PlanningMedia[]> {
  if (items.length === 0) return [];
  const ids = items.map((m) => m.id);
  const byId = new Map<string, { filename: string; tags: readonly string[] }>();
  // De a 100 (`PAGINATION.limitMax`): una página por tanda de ids.
  for (let i = 0; i < ids.length; i += 100) {
    const page = await mediaRepository.listByPage(
      tx,
      { companyId },
      { page: 1, limit: 100, filter: { mediaId: { in: ids.slice(i, i + 100) } } },
    );
    for (const r of page.items) {
      byId.set(r.mediaId, { filename: r.filename, tags: r.tags });
    }
  }

  const videos = items
    .filter((m) => m.mediaType === "video")
    .slice(0, PLANNING_META_READS);
  const clipTags = new Map<string, ReturnType<typeof parseClipTags>>();
  if (storage !== undefined) {
    for (let i = 0; i < videos.length; i += META_CONCURRENCY) {
      const batch = videos.slice(i, i + META_CONCURRENCY);
      await Promise.all(
        batch.map(async (m) => {
          try {
            const raw = await readJsonObject(storage, mediaMetaKey(companyId, m.id));
            const tags =
              typeof raw === "object" && raw !== null
                ? parseClipTags((raw as Record<string, unknown>)["tags"])
                : null;
            if (tags !== null) clipTags.set(m.id, tags);
          } catch {
            // Mejor esfuerzo: sin etiquetas compite con su título.
          }
        }),
      );
    }
  }

  return items.map((m) => {
    const row = byId.get(m.id);
    const rowTags = (row?.tags ?? []).filter((t) => t !== AUTO_FOUND_TAG);
    const fromMeta = clipTags.get(m.id) ?? null;
    const tags =
      fromMeta === null && rowTags.length === 0
        ? null
        : {
            emotion: fromMeta?.emotion ?? "",
            situation: fromMeta?.situation ?? "",
            people: fromMeta?.people ?? 0,
            tags: [...new Set([...(fromMeta?.tags ?? []), ...rowTags])],
          };
    return {
      ...m,
      title: row?.filename ?? null,
      tags,
      autoFound: (row?.tags ?? []).includes(AUTO_FOUND_TAG),
    };
  });
}
