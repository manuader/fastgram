/**
 * Importar video o audio por link — `PU-MEME-001`, `docs/PLAN-USO-PERSONAL.md`
 * §6 (D-12: el dueño asume los derechos de lo que publica).
 *
 * Lo que no es IO: qué URL se acepta, qué topes aplican, qué viaja en la cola
 * `media-import`, dónde queda el estado consultable y qué categorías recibe el
 * clip según lo que se midió. La API (`apps/api/src/routes/v1/media.ts`) encola,
 * el worker (`apps/worker/src/media-import`) baja con `yt-dlp` y sube.
 *
 * ## Dónde vive el estado, sin migración
 *
 * `DATA-010` no tiene columnas para el estado de un import, el motivo de un
 * fallo, la URL de origen ni las etiquetas, y esta tarea no tiene migración.
 * Así que el estado va a **un objeto JSON en el storage del workspace**
 * ({@link importStatusKey}), bajo un prefijo que lleva el `companyId`: pedir el
 * import de otra marca busca en otro prefijo y no encuentra nada (404). Lo
 * escribe la API al encolar (`queued`) y el worker en cada transición.
 *
 * La URL de origen y las etiquetas van a otro objeto por clip
 * ({@link mediaMetaKey}); `GET /media/meta` los junta. Cuando exista la
 * migración con columnas, esto se muda ahí y los objetos se descartan.
 */
import type {
  ClipTags,
  MediaImportFailureCode,
  MediaImportKind,
  ModelRegistrySnapshot,
} from "@fastgram/ports";
import { MEDIA_IMPORT_FAILURE_CODES } from "@fastgram/ports";

import { DomainError } from "../errors.js";
import { assertHostAllowed } from "../brand/source-input.js";
import { resolveApiKey, type SecretEnv } from "../models/config.js";

/* ------------------------------------------------------------------------ *
 * Topes
 * ------------------------------------------------------------------------ */

/** Default del brief: un meme dura segundos; tres minutos ya es mucho. */
export const DEFAULT_MEDIA_IMPORT_MAX_DURATION_SECONDS = 180;

/**
 * El tope de video del contrato (`UPLOAD_VIDEO_MAX_MB`, 50 MB, `§9.8`). Está
 * escrito dos veces porque `core` no importa `contracts`; el test de la ruta
 * los ata.
 */
export const MEDIA_IMPORT_MAX_MB = 50;
export const MEDIA_IMPORT_MAX_BYTES = MEDIA_IMPORT_MAX_MB * 1024 * 1024;

/**
 * Tope duro de la bajada. Un clip de tres minutos baja en segundos por una
 * conexión doméstica; cinco minutos es margen para una lenta, y más es un
 * cuelgue.
 */
export const MEDIA_IMPORT_TIMEOUT_MS = 5 * 60_000;

/** Largo máximo de la URL aceptada. Sanidad del input, no del producto. */
const MAX_URL_LENGTH = 2048;

/* ------------------------------------------------------------------------ *
 * URL
 * ------------------------------------------------------------------------ */

export type ImportUrlCheck =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly code: "unsupported_url"; readonly message: string };

function isMappedPrivateIpv6(host: string): boolean {
  // `[::ffff:127.0.0.1]` llega normalizado como `[::ffff:7f00:1]`; el filtro de
  // `assertHostAllowed` mira dotted-quad e IPv6 nativas, no las mapeadas.
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  return h.startsWith("::ffff:") || h.startsWith("0:0:0:0:0:ffff:");
}

/**
 * Sólo `http(s)`, sin credenciales, y nunca un host de la red local.
 *
 * Un nombre público que resuelve a la red local lo filtra el adaptador
 * (`YtDlpDownloader` resuelve antes de lanzar). Lo que **nadie** cierra, y
 * está en el reporte: el DNS rebinding y los redirects, porque `yt-dlp`
 * resuelve y sigue redirects por su cuenta. Para uso personal (la URL la pega
 * el dueño) es el riesgo aceptado.
 */
export function checkImportUrl(raw: string): ImportUrlCheck {
  const value = raw.trim();
  const fail = (message: string): ImportUrlCheck => ({
    ok: false,
    code: "unsupported_url",
    message,
  });
  if (value.length === 0) return fail("Paste a link.");
  if (value.length > MAX_URL_LENGTH) return fail("That link is too long.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return fail("That is not a valid link.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return fail("Only http and https links can be imported.");
  }
  if (url.username !== "" || url.password !== "") {
    return fail("Links with credentials can't be imported.");
  }
  if (isMappedPrivateIpv6(url.hostname)) {
    return fail("Links to private addresses can't be imported.");
  }
  try {
    assertHostAllowed(url.hostname);
  } catch (error) {
    if (error instanceof DomainError) {
      return fail("Links to local or private addresses can't be imported.");
    }
    throw error;
  }
  return { ok: true, url: url.toString() };
}

export function isMediaImportFailureCode(
  value: unknown,
): value is MediaImportFailureCode {
  return (
    typeof value === "string" &&
    (MEDIA_IMPORT_FAILURE_CODES as readonly string[]).includes(value)
  );
}

/* ------------------------------------------------------------------------ *
 * El job
 * ------------------------------------------------------------------------ */

/**
 * Payload de `media-import`. `mediaId` lo elige la API: así el reintento del
 * job crea **la misma** fila (o ve que ya está) en vez de duplicar el clip.
 */
export interface MediaImportJob {
  readonly companyId: string;
  readonly importId: string;
  readonly mediaId: string;
  readonly url: string;
  readonly kind: MediaImportKind;
  readonly categories: readonly string[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseMediaImportJob(
  payload: unknown,
): { ok: true; job: MediaImportJob } | { ok: false; reason: string } {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "el payload no es un objeto" };
  }
  const p = payload as Record<string, unknown>;
  for (const field of ["companyId", "importId", "mediaId"] as const) {
    const v = p[field];
    if (typeof v !== "string" || !UUID.test(v)) {
      return { ok: false, reason: `${field} ausente o no es un uuid` };
    }
  }
  if (p["kind"] !== "video" && p["kind"] !== "audio") {
    return { ok: false, reason: "kind no es video ni audio" };
  }
  if (typeof p["url"] !== "string") return { ok: false, reason: "url ausente" };
  const categories = p["categories"] ?? [];
  if (!Array.isArray(categories) || !categories.every((c) => typeof c === "string")) {
    return { ok: false, reason: "categories no es una lista de strings" };
  }
  return {
    ok: true,
    job: {
      companyId: p["companyId"] as string,
      importId: p["importId"] as string,
      mediaId: p["mediaId"] as string,
      url: p["url"],
      kind: p["kind"],
      categories: categories as string[],
    },
  };
}

/**
 * Clave de idempotencia del encolado. Por import, que es nuevo en cada `POST`
 * (trampa 39: una clave fija dispara una vez en la vida; ésta nunca se repite
 * entre pedidos distintos). El replay de la misma `Idempotency-Key` lo resuelve
 * la API antes de llegar acá.
 */
export function mediaImportSingletonKey(importId: string): string {
  return `media-import:${importId}`;
}

/* ------------------------------------------------------------------------ *
 * Estado consultable
 * ------------------------------------------------------------------------ */

export type MediaImportState =
  /** Encolado, nadie lo tomó todavía. */
  | "queued"
  /** El worker está bajando o midiendo. */
  | "downloading"
  /** El archivo ya está en el Media Bank; puede seguir `processing` (normalización). */
  | "imported"
  | "failed";

/**
 * Qué pasó con el fondo del clip (`PU-MEME-002`). Sólo se intenta cuando el
 * clip se pidió como `green-screen-video`: recortar cuesta plata con fal y no
 * todo video importado es un foreground.
 */
export type BackgroundState =
  | "not_requested"
  /** Se está midiendo o recortando. */
  | "pending"
  /** El borde es verde: lo recorta el croma del render. */
  | "green_screen"
  /** Hay un clip nuevo con alfa (`cutoutMediaId`). */
  | "removed"
  /** No es verde y no hay proveedor configurado. */
  | "needs_background_removal"
  /** El proveedor falló. El clip original queda igual. */
  | "failed";

/** `skipped` = no hay modelo de visión configurado (tarea `vision`). */
export type TaggingState = "pending" | "tagged" | "skipped" | "failed";

export interface MediaImportStatus {
  readonly importId: string;
  readonly kind: MediaImportKind;
  readonly state: MediaImportState;
  readonly sourceUrl: string;
  /** El id del job en la cola, para detectar un job muerto sin que el worker escriba. */
  readonly jobId?: string;
  readonly mediaId?: string;
  readonly cutoutMediaId?: string;
  readonly error?: MediaImportFailureCode;
  readonly background?: BackgroundState;
  readonly tagging?: TaggingState;
  readonly tags?: ClipTags;
  /** Sólo audio: dónde quedó el archivo (no hay fila en `media` para audio). */
  readonly audioUrl?: string;
  /** ms epoch. */
  readonly updatedAt: number;
}

/** Objeto del estado de un import. El `companyId` en el prefijo es el scope. */
export function importStatusKey(companyId: string, importId: string): string {
  return `media-imports/${companyId}/${importId}.json`;
}

/** Metadata de un clip importado: origen, etiquetas y recorte. */
export interface MediaMeta {
  readonly mediaId: string;
  readonly sourceUrl?: string;
  readonly tags?: ClipTags;
  readonly background?: BackgroundState;
  /** El clip con alfa derivado de éste, o el original del que salió éste. */
  readonly cutoutMediaId?: string;
  readonly cutoutOf?: string;
}

export function mediaMetaPrefix(companyId: string): string {
  return `media-meta/${companyId}/`;
}

export function mediaMetaKey(companyId: string, mediaId: string): string {
  return `${mediaMetaPrefix(companyId)}${mediaId}.json`;
}

/**
 * Lee un estado guardado. Es JSON escrito por nosotros, pero viene de un
 * bucket: se valida por forma y lo que no encaja es `null` (= no existe).
 */
export function parseMediaImportStatus(raw: unknown): MediaImportStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const states: readonly string[] = ["queued", "downloading", "imported", "failed"];
  if (typeof s["importId"] !== "string" || !UUID.test(s["importId"])) return null;
  if (s["kind"] !== "video" && s["kind"] !== "audio") return null;
  if (typeof s["state"] !== "string" || !states.includes(s["state"])) return null;
  if (typeof s["sourceUrl"] !== "string") return null;
  if (typeof s["updatedAt"] !== "number") return null;
  if (s["error"] !== undefined && !isMediaImportFailureCode(s["error"])) return null;
  return raw as MediaImportStatus;
}

/* ------------------------------------------------------------------------ *
 * Categorías según lo medido
 * ------------------------------------------------------------------------ */

export const GREEN_SCREEN_CATEGORY = "green-screen-video";

/** ¿El usuario pidió el clip como foreground? Es lo que dispara el recorte. */
export function wantsForeground(categories: readonly string[]): boolean {
  return categories.includes(GREEN_SCREEN_CATEGORY);
}

/**
 * Categorías del clip **original** después de medirlo.
 *
 * - Verde → suma `green-screen-video` aunque no se haya pedido: el render lo
 *   puede usar tal cual, y no marcarlo lo dejaría fuera del pool.
 * - No verde → **saca** `green-screen-video`: el croma sobre un clip que no
 *   es verde recorta cualquier cosa. El foreground, si hay, es el clip con alfa.
 */
export function categoriesForOriginal(
  requested: readonly string[],
  isGreen: boolean,
): string[] {
  const rest = requested.filter((c) => c !== GREEN_SCREEN_CATEGORY);
  const unique = [...new Set(rest)];
  return isGreen ? [...unique, GREEN_SCREEN_CATEGORY] : unique;
}

/* ------------------------------------------------------------------------ *
 * Configuración del recorte (fal)
 * ------------------------------------------------------------------------ */

/**
 * Único origen aceptado para el recorte por fal. Verificado en
 * https://fal.ai/docs/model-apis/model-endpoints/queue (2026-09-24): el submit
 * es `POST https://queue.fal.run/{endpoint}` con `Authorization: Key …`.
 *
 * Se exige este origen y no cualquiera: el adaptador habla el protocolo de
 * cola de fal, y una base URL de otro host recibiría la key de fal.
 */
export const FAL_QUEUE_BASE_URL = "https://queue.fal.run";

/**
 * Endpoint de video de BiRefNet v2, verificado en
 * https://fal.ai/models/fal-ai/birefnet/v2/video/api (2026-09-24). Es el
 * default si la tarea no nombra modelo; el usuario puede escribir otro.
 */
export const FAL_BIREFNET_VIDEO_ENDPOINT = "fal-ai/birefnet/v2/video";

export interface BackgroundRemovalConfig {
  readonly baseUrl: string;
  readonly endpoint: string;
  readonly apiKey: string;
}

export type BackgroundRemovalResolution =
  | { readonly ok: true; readonly config: BackgroundRemovalConfig }
  | { readonly ok: false; readonly why: "unset" | "no_key" | "unsupported_endpoint" };

const ENDPOINT_ID = /^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)+$/i;

/**
 * La tarea `background_removal` del registro, si apunta a fal y tiene key.
 * Acepta el proveedor que sea (`custom` hoy; un preset `fal` si aparece) y
 * decide por el origen de la base URL.
 */
export function resolveBackgroundRemovalConfig(
  snapshot: ModelRegistrySnapshot,
  secrets: SecretEnv,
): BackgroundRemovalResolution {
  const entry = snapshot.tasks.background_removal;
  if (entry === undefined) return { ok: false, why: "unset" };
  let origin: string;
  try {
    const u = new URL(entry.baseUrl);
    origin = u.origin;
    if (u.pathname !== "/" && u.pathname !== "") {
      return { ok: false, why: "unsupported_endpoint" };
    }
  } catch {
    return { ok: false, why: "unsupported_endpoint" };
  }
  if (origin !== FAL_QUEUE_BASE_URL) return { ok: false, why: "unsupported_endpoint" };
  const model = entry.model.trim();
  const endpoint = model.length === 0 ? FAL_BIREFNET_VIDEO_ENDPOINT : model;
  if (!ENDPOINT_ID.test(endpoint)) return { ok: false, why: "unsupported_endpoint" };
  const key = resolveApiKey(entry, secrets);
  if (key === null) return { ok: false, why: "no_key" };
  return { ok: true, config: { baseUrl: FAL_QUEUE_BASE_URL, endpoint, apiKey: key.key } };
}
