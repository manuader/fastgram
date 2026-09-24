/**
 * Extraer el audio de un video del Media Bank — cola `audio-extract` (sprint
 * 7, segunda tanda, agente H). Pendiente del agente B: "Extract from a video"
 * en Library → Audio.
 *
 * Lo que no es IO: qué viaja en la cola, dónde vive el estado consultable, los
 * topes y los códigos de falla. La API (`apps/api/src/routes/v1/audio-library.ts`)
 * encola; el worker (`apps/worker/src/audio-extract`) baja el video del
 * storage, corre FFmpeg y crea la pista (`brand_audio_tracks`, origen
 * `extracted`).
 *
 * ## Dónde vive el estado, sin tabla
 *
 * Igual que `media-import` (`../media-import/media-import.ts`): un JSON en el
 * storage bajo un prefijo con el `companyId` ({@link audioExtractionStatusKey}).
 * Pedir la extracción de otra marca busca en otro prefijo y no encuentra nada
 * (404). La API lo escribe al encolar (`queued`), el worker en cada
 * transición. La pista resultante sí es una fila: la idempotencia del
 * reintento es `UNIQUE (company_id, import_id)` con `import_id = extractionId`.
 */

/**
 * Tope de duración, en segundos. **Decisión nuestra** (el PRD no lo fija):
 * una pista para un short dura segundos o un par de minutos; 5 minutos a
 * 128 kb/s son ~5 MB, bajo el tope de 20 MB de la biblioteca. Más largo se
 * rechaza (`too_long`), no se recorta en silencio. `@fastgram/contracts`
 * repite el número (`AUDIO_EXTRACT_MAX_SECONDS`); un test de la API los ata.
 */
export const AUDIO_EXTRACT_MAX_SECONDS = 300;

/** Tope duro de FFmpeg. Extraer 5 minutos de audio tarda segundos. */
export const AUDIO_EXTRACT_TIMEOUT_MS = 2 * 60_000;

/** El tamaño máximo del video que se baja del storage para extraer (el tope de subida de video). */
export const AUDIO_EXTRACT_MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export const AUDIO_EXTRACTION_ERRORS = [
  "media_not_found",
  "no_audio",
  "too_long",
  "too_large",
  "extract_failed",
] as const;
export type AudioExtractionErrorCode = (typeof AUDIO_EXTRACTION_ERRORS)[number];

export type AudioExtractionStateName = "queued" | "extracting" | "done" | "failed";

export interface AudioExtractionStatus {
  readonly id: string;
  readonly mediaId: string;
  readonly state: AudioExtractionStateName;
  readonly trackId?: string;
  readonly error?: AudioExtractionErrorCode;
  /** El id del job, para detectar un job muerto sin que el worker escriba. */
  readonly jobId?: string;
  /** ms epoch. */
  readonly updatedAt: number;
}

export interface AudioExtractJob {
  readonly companyId: string;
  readonly extractionId: string;
  readonly mediaId: string;
  /** El título que eligió el usuario; sin él, el nombre del video. */
  readonly title?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Objeto del estado de una extracción. El `companyId` en el prefijo es el scope. */
export function audioExtractionStatusKey(
  companyId: string,
  extractionId: string,
): string {
  return `audio-extractions/${companyId}/${extractionId}.json`;
}

export type ParsedAudioExtractJob =
  | { readonly ok: true; readonly job: AudioExtractJob }
  | { readonly ok: false; readonly reason: string };

/** El payload vuelve de la cola como `unknown`: se valida por forma. */
export function parseAudioExtractJob(payload: unknown): ParsedAudioExtractJob {
  if (typeof payload !== "object" || payload === null) {
    return { ok: false, reason: "el payload no es un objeto" };
  }
  const p = payload as Record<string, unknown>;
  for (const key of ["companyId", "extractionId", "mediaId"] as const) {
    const v = p[key];
    if (typeof v !== "string" || !UUID.test(v)) {
      return { ok: false, reason: `${key} no es un uuid` };
    }
  }
  const title = p["title"];
  if (title !== undefined && (typeof title !== "string" || title.trim() === "")) {
    return { ok: false, reason: "title no es un texto" };
  }
  return {
    ok: true,
    job: {
      companyId: p["companyId"] as string,
      extractionId: p["extractionId"] as string,
      mediaId: p["mediaId"] as string,
      ...(typeof title === "string" ? { title: title.trim().slice(0, 200) } : {}),
    },
  };
}

/** Un estado guardado en el bucket: se valida por forma; lo que no encaja es `null`. */
export function parseAudioExtractionStatus(raw: unknown): AudioExtractionStatus | null {
  if (typeof raw !== "object" || raw === null) return null;
  const s = raw as Record<string, unknown>;
  const states: readonly string[] = ["queued", "extracting", "done", "failed"];
  if (typeof s["id"] !== "string" || !UUID.test(s["id"])) return null;
  if (typeof s["mediaId"] !== "string" || !UUID.test(s["mediaId"])) return null;
  if (typeof s["state"] !== "string" || !states.includes(s["state"])) return null;
  if (typeof s["updatedAt"] !== "number") return null;
  if (
    s["error"] !== undefined &&
    !(AUDIO_EXTRACTION_ERRORS as readonly unknown[]).includes(s["error"])
  ) {
    return null;
  }
  if (
    s["trackId"] !== undefined &&
    (typeof s["trackId"] !== "string" || !UUID.test(s["trackId"]))
  ) {
    return null;
  }
  return raw as AudioExtractionStatus;
}

/** El título por defecto de una pista extraída: el nombre del video sin extensión. */
export function extractedAudioTitle(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).replace(/\s+/g, " ").trim();
  return (stem === "" ? "Extracted audio" : `${stem} (audio)`).slice(0, 200);
}
