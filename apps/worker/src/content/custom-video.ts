/**
 * El build de una pieza `custom` — el video propio del Content Studio
 * (`P2-STUDIO-009`, `F-083`, `FR-070` PRD:1463, §9.5 #7).
 *
 * No es un render: el archivo ya está subido. Es **normalización** (MOV→MP4,
 * faststart, HDR→SDR donde se pueda — `media/normalize-video.ts`) +
 * **miniatura**, y la pieza cierra `CREATED` con ese archivo.
 *
 * ## De dónde sale el archivo
 *
 * `POST /content/custom/video` deja en `buildPayload` la clave del objeto
 * (`{ customVideo: { storageKey, contentType, filename } }`). Antes no la
 * guardaba en ningún lado y cada video propio terminaba `FAILED` con
 * `custom_not_renderable`. Una fila vieja sin esa forma sigue cerrando así.
 *
 * ## Con qué renderer
 *
 * Con el de **normalización** (`normalizationRenderer`, otro presupuesto de
 * tiempo: un MOV de 50 MB puede pasar los 2 min de un build — trampa 46), no
 * con el del build. Sin servicio de render configurado no hay con qué medir
 * ni transcodificar: la pieza queda con el original tal cual y la marca
 * `not_normalized` en `buildPayload.customVideo.normalization`.
 */
import { canonicalObjectUrl } from "@fastgram/adapters";
import type { MediaRenderer, Storage, StorageKey } from "@fastgram/ports";

import { normalizeVideo } from "../media/normalize-video.js";
import { workspaceMediaAuthorization } from "./media-authorization.js";

export interface CustomVideoSource {
  readonly storageKey: string;
  readonly contentType: string;
  readonly filename: string;
}

/** Qué hizo el build con el archivo. Queda en `buildPayload.customVideo`. */
export type CustomVideoNormalization =
  "normalized" | "already_normalized" | "hdr_kept_original" | "not_normalized";

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * La fuente de una pieza `custom`, o `null` si la fila es anterior a que se
 * guardara (o la forma está rota). La clave tiene que caer bajo el prefijo de
 * videos propios **de esta marca**: una fila con otra clave no se lee.
 */
export function parseCustomVideoPayload(
  buildPayload: unknown,
  companyId: string,
): CustomVideoSource | null {
  if (!isRecord(buildPayload)) return null;
  const cv = buildPayload["customVideo"];
  if (!isRecord(cv)) return null;
  const { storageKey, contentType, filename } = cv;
  if (typeof storageKey !== "string" || typeof contentType !== "string") return null;
  if (!storageKey.startsWith(`content/custom-video/${companyId}/`)) return null;
  if (storageKey.includes("..")) return null;
  return {
    storageKey,
    contentType,
    filename: typeof filename === "string" ? filename : "",
  };
}

export interface CustomVideoBuild {
  readonly files: readonly string[];
  readonly thumbnailUrl?: string;
  /** Lo que se subió en esta corrida (para descartarlo si la pieza cambió). */
  readonly uploaded: readonly StorageKey[];
  readonly normalization: CustomVideoNormalization;
}

export interface CustomVideoDeps {
  readonly normalizer: MediaRenderer | null;
  readonly storage: Storage;
  readonly logger: { warn(obj: Record<string, unknown>, msg: string): void };
}

/**
 * Normaliza y saca la miniatura. Los errores del puerto se propagan: los
 * clasifica el handler (reintento, `FAILED`). La miniatura es best-effort,
 * como en un build: una pieza sin preview es utilizable.
 */
export async function buildCustomVideo(
  deps: CustomVideoDeps,
  input: {
    readonly companyId: string;
    readonly contentId: string;
    readonly revision: number;
    readonly objectPrefix: string;
    readonly source: CustomVideoSource;
  },
): Promise<CustomVideoBuild> {
  const sourceUrl = await canonicalObjectUrl(deps.storage, input.source.storageKey);
  if (deps.normalizer === null) {
    return { files: [sourceUrl], uploaded: [], normalization: "not_normalized" };
  }
  const normalizer = deps.normalizer;
  const base = `${input.objectPrefix}/${input.companyId}/${input.contentId}/${String(input.revision)}`;
  const authFor = (url: string) =>
    workspaceMediaAuthorization(deps.storage, {
      companyId: input.companyId,
      objectPrefix: input.objectPrefix,
      urls: [url],
    });

  const uploaded: StorageKey[] = [];
  const result = await normalizeVideo(normalizer, sourceUrl, await authFor(sourceUrl));
  let fileUrl = sourceUrl;
  if (result.kind === "normalized") {
    const stored = await deps.storage.put({
      // La revisión en la clave, como un build: un rebuild no pisa lo que un
      // post ya programado referencia.
      key: `${base}/0.mp4`,
      body: result.media.body,
      contentType: result.media.contentType,
    });
    uploaded.push(stored.key);
    fileUrl = await canonicalObjectUrl(deps.storage, stored.key);
  }

  let thumbnailUrl: string | undefined;
  try {
    const thumb = await normalizer.thumbnail(
      { url: fileUrl, maxWidth: 480 },
      await authFor(fileUrl),
    );
    const stored = await deps.storage.put({
      key: `${base}/thumb`,
      body: thumb.body,
      contentType: thumb.contentType,
    });
    uploaded.push(stored.key);
    thumbnailUrl = await canonicalObjectUrl(deps.storage, stored.key);
  } catch (error: unknown) {
    deps.logger.warn(
      { contentId: input.contentId, error },
      "no se pudo generar el thumbnail del video propio",
    );
  }

  return {
    files: [fileUrl],
    ...(thumbnailUrl === undefined ? {} : { thumbnailUrl }),
    uploaded,
    normalization: result.kind,
  };
}
