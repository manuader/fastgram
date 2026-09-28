/**
 * La biblioteca global en la selección del refill — sprint 9 (T), `PU-S9-015`,
 * D-19.
 *
 * Dos cosas:
 *
 *  1. **Candidatos**: las filas `ready` de `library_assets` del tipo que el rol
 *     acepta (`listLibraryCandidates` de N, ordenadas por texto contra la idea),
 *     convertidas con `libraryAssetCandidate` de `core`. La licencia la filtra
 *     el decisor (`exclusionFor`, O): acá no se descarta nada por licencia, para
 *     que el motivo quede en `asset_decisions`.
 *  2. **Materializar al ganador**: si gana un asset de la biblioteca, se
 *     **copia** al Media Bank de la marca y la sugerencia apunta a esa copia.
 *
 * ## Por qué copiar y no referenciar `library/…` (decisión que el PRD no cubre)
 *
 * Aceptar una sugerencia verifica y bloquea **cada `mediaId` del plan en la
 * tabla `media` de la marca** (`lockLiveMedia` en `POST /blitz`, y lo mismo el
 * piloto y las campañas): un id de `library_assets` ahí da `media_unavailable`
 * y la sugerencia se descarta sin construirse. Referenciar la biblioteca exige
 * tocar esos tres caminos; copiar no toca ninguno. Es además lo que ya decidió
 * N para «Usar en marca» (`apps/api/src/routes/v1/library.ts`): borrar una media
 * de la marca borra su objeto, y eso no puede llevarse el asset global.
 *
 * La copia es **idempotente**: su `mediaId` se deriva de (marca, asset), así que
 * el mismo asset elegido en diez rellenos es una sola fila. Si el dueño la borró
 * del Media Bank, se respeta: ese asset deja de ofrecerse a esa marca.
 *
 * Nada de esto hace fallar el refill: un error al listar es «sin biblioteca»,
 * y uno al copiar es «queda lo que había elegido la marca».
 */
import { createHash } from "node:crypto";

import { canonicalObjectUrl } from "@fastgram/adapters";
import {
  BYTES_PER_MB,
  LIBRARY_KIND_MEDIA_CATEGORY,
  libraryAssetMetadataSchema,
  libraryLicenseSchema,
  type LibraryAssetKind,
} from "@fastgram/contracts";
import {
  libraryAssetCandidate,
  libraryKindsForRole,
  mediaMetaKey,
  type AssetCandidate,
  type AssetRole,
  type DecisionFormat,
  type PlanningMedia,
} from "@fastgram/core";
import {
  addMediaTag,
  listLibraryCandidates,
  mediaRepository,
  withCompany,
  type Database,
  type LibraryAssetRow,
  type Transaction,
} from "@fastgram/db";
import type { Storage } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";

/**
 * Cuántas filas se piden por decisión. El decisor igual corta en su shortlist
 * (20, `DEFAULT_SHORTLIST_SIZE`) sumando las de la marca: con 12 de la
 * biblioteca, la marca no queda afuera por cantidad, y la base ya las trae
 * ordenadas por texto contra la idea.
 */
export const LIBRARY_CANDIDATES_PER_DECISION = 12;

export interface LibrarySource {
  /** Los candidatos de la biblioteca para un rol. Nunca lanza (vacío = sin biblioteca). */
  candidates(input: {
    readonly format: DecisionFormat;
    readonly role: AssetRole;
    readonly idea: string | null;
  }): Promise<readonly AssetCandidate[]>;
  /**
   * La copia en el Media Bank de la marca de un asset que ganó, o `null` si no
   * se pudo (el refill se queda con lo que había). Nunca lanza.
   */
  materialize(assetId: string): Promise<PlanningMedia | null>;
}

/**
 * El `mediaId` de la copia de un asset global en una marca: un uuid (forma v5)
 * derivado de los dos ids. Determinista, así la copia es idempotente.
 */
export function libraryCopyMediaId(companyId: string, assetId: string): string {
  const h = createHash("sha256").update(`library-copy:${companyId}:${assetId}`).digest();
  h[6] = ((h[6] ?? 0) & 0x0f) | 0x50;
  h[8] = ((h[8] ?? 0) & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}

async function readAll(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function createLibrarySource(deps: {
  readonly db: Database;
  readonly storage: Storage;
  readonly companyId: string;
  readonly appRole: string | undefined;
  readonly logger: BuildLogger;
}): LibrarySource {
  const inCompany = <T>(fn: (tx: Transaction) => Promise<T>): Promise<T> =>
    withCompany(
      deps.db,
      deps.companyId,
      fn,
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );
  /** Las filas vistas en este job, para copiar la ganadora sin volver a leerla. */
  const seen = new Map<string, LibraryAssetRow>();
  /** Assets cuya copia el dueño borró de esta marca: no se ofrecen. */
  const refused = new Set<string>();

  async function copyExists(assetId: string): Promise<"live" | "deleted" | "none"> {
    const row = await inCompany((tx) =>
      mediaRepository.findById(
        tx,
        { companyId: deps.companyId },
        libraryCopyMediaId(deps.companyId, assetId),
        { includeDeleted: true },
      ),
    );
    if (row === null) return "none";
    return row.deletedAt === null ? "live" : "deleted";
  }

  return {
    async candidates({ format, role, idea }) {
      const kinds = libraryKindsForRole(format, role);
      if (kinds.length === 0) return [];
      let rows: LibraryAssetRow[];
      try {
        rows = await inCompany((tx) =>
          listLibraryCandidates(tx, {
            kinds,
            ...(idea === null || idea.trim() === "" ? {} : { text: idea }),
            limit: LIBRARY_CANDIDATES_PER_DECISION,
          }),
        );
      } catch (error: unknown) {
        deps.logger.warn(
          {
            companyId: deps.companyId,
            reason: error instanceof Error ? error.message : String(error),
          },
          "no se pudo leer la biblioteca global: el refill sigue con el Media Bank",
        );
        return [];
      }
      const out: AssetCandidate[] = [];
      for (const row of rows) {
        if (refused.has(row.id) || row.storageKey === null) continue;
        const meta = libraryAssetMetadataSchema.safeParse(row.metadata);
        const candidate = libraryAssetCandidate(
          { ...row, metadata: meta.success ? meta.data : null },
          { format, role },
        );
        if (candidate === null) continue;
        seen.set(row.id, row);
        out.push(candidate);
      }
      return out;
    },

    async materialize(assetId) {
      const row = seen.get(assetId);
      if (row === undefined || row.storageKey === null) return null;
      const kind = row.kind as LibraryAssetKind;
      if (kind === "audio") return null;
      const mediaId = libraryCopyMediaId(deps.companyId, assetId);
      const category = LIBRARY_KIND_MEDIA_CATEGORY[kind];
      const meta = libraryAssetMetadataSchema.safeParse(row.metadata);
      const tags = meta.success
        ? meta.data.tags.slice(0, 10).map((t) => t.toLowerCase())
        : [];
      const planning = (url: string): PlanningMedia => ({
        id: mediaId,
        mediaType: row.mediaType === "video" ? "video" : "image",
        url,
        categories: [category],
        title: row.title,
        tags: {
          emotion: meta.success ? meta.data.emotions.join(" ") : "",
          situation: meta.success ? meta.data.description : "",
          people: 0,
          tags,
        },
      });
      try {
        const existing = await copyExists(assetId);
        if (existing === "deleted") {
          refused.add(assetId);
          deps.logger.info(
            { companyId: deps.companyId, assetId },
            "el dueño borró la copia de este asset global: no se vuelve a ofrecer",
          );
          return null;
        }
        if (existing === "live") {
          const live = await inCompany((tx) =>
            mediaRepository.findById(tx, { companyId: deps.companyId }, mediaId),
          );
          return live === null ? null : planning(live.r2Url);
        }

        const extension = row.storageKey.split(".").pop() ?? "bin";
        const head = await deps.storage.head(row.storageKey);
        if (head === null) return null;
        const stored = await deps.storage.put({
          key: `media/${deps.companyId}/library/${mediaId}.${extension}`,
          body: await readAll(await deps.storage.get(row.storageKey)),
          contentType: head.contentType,
        });
        const url = await canonicalObjectUrl(deps.storage, stored.key);
        try {
          await inCompany(async (tx) => {
            const scope = { companyId: deps.companyId };
            await mediaRepository.create(tx, scope, {
              mediaId,
              mediaType: row.mediaType === "video" ? "video" : "image",
              filename: `${row.title.slice(0, 180)}.${extension}`,
              r2Url: url,
              storageKey: stored.key,
              // Ya normalizado por el import de la biblioteca (igual que N).
              status: "ready",
              sizeMb: stored.sizeBytes / BYTES_PER_MB,
              ...(row.mediaType === "video" && row.durationSec !== null
                ? { videoDurationSec: Math.round(row.durationSec) }
                : {}),
              categories: [category],
              // Mismo origen que «Usar en marca» (N): uno propio exige migrar
              // el CHECK de `media`. La ruta `…/library/…` es la que lo delata
              // (`isLibraryCopyLocation`).
              origin: "manual_upload",
            });
            for (const tag of tags) await addMediaTag(tx, scope, mediaId, tag);
          });
        } catch (error: unknown) {
          // Otra entrega la creó a la vez (misma clave y mismo objeto): sirve.
          if ((await copyExists(assetId)) === "live") return planning(url);
          // Sin fila, la copia es un huérfano.
          await deps.storage.delete(stored.key).catch(() => undefined);
          throw error;
        }
        // La procedencia, en el mismo sidecar que escribe «Usar en marca».
        const license = libraryLicenseSchema.safeParse(row.license);
        await deps.storage
          .put({
            key: mediaMetaKey(deps.companyId, mediaId),
            body: new TextEncoder().encode(
              JSON.stringify({
                mediaId,
                ...(license.success && license.data.sourceUrl !== undefined
                  ? { sourceUrl: license.data.sourceUrl }
                  : {}),
                ...(meta.success &&
                (meta.data.chroma.type === "green" || meta.data.chroma.type === "blue")
                  ? { background: "green_screen" }
                  : {}),
                library: {
                  assetId,
                  license: license.success ? license.data : null,
                  metadata: meta.success ? meta.data : null,
                  via: "refill",
                },
              }),
            ),
            contentType: "application/json",
            cacheControl: "no-store",
          })
          .catch(() => undefined);
        deps.logger.info(
          { companyId: deps.companyId, assetId, mediaId },
          "asset de la biblioteca global copiado a la marca (ganó en el decisor)",
        );
        return planning(url);
      } catch (error: unknown) {
        deps.logger.warn(
          {
            companyId: deps.companyId,
            assetId,
            reason: error instanceof Error ? error.message : String(error),
          },
          "no se pudo copiar el asset global a la marca: queda lo que eligió la marca",
        );
        return null;
      }
    },
  };
}
