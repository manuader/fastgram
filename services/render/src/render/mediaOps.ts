/**
 * `P2-RENDER-016` — `normalize`, `probe` y `thumbnail` como operaciones del
 * servicio.
 *
 * El puerto `MediaRenderer` tiene cuatro métodos y hasta acá **uno solo tenía
 * ruta HTTP**. Los otros tres existían como código interno —`ffmpeg/normalize.ts`,
 * `ffmpeg/probe.ts`— sin forma de llamarlos desde afuera, así que el adaptador
 * los resolvía tirando `provider_unavailable` y `NFR-014`, `ERR-P11` y
 * `P2-RENDER-013` se quedaban sin implementación del lado del producto.
 *
 * ── La forma sale del puerto, no de la comodidad de acá ──────────────────────
 * El contrato ya está escrito en `packages/ports/src/media-renderer.ts` y el
 * adaptador ya lo implementa del otro lado. Entonces:
 *
 *   · `probe(url)` no devuelve bytes → respuesta JSON y nada más.
 *   · `normalize` y `thumbnail` devuelven `RenderedMedia` —`body`,
 *     `contentType`, `sizeBytes`, `width`, `height`, `durationSeconds?`— así
 *     que la respuesta trae **todos esos campos menos `body`**, y `body` se
 *     baja con el `href`. El adaptador ya sabe armar un `RenderedMedia` con esa
 *     combinación: es exactamente lo que hace con `POST /render`.
 *
 * Y los bytes salen por `GET /artifact/<clave>.<ext>`, el que ya existe, en vez
 * de una segunda forma de bajar un archivo. Una sola ruta que sirve bytes es
 * una sola ruta que auditar por path traversal.
 *
 * ── Las claves son del CONTENIDO, no de la URL ───────────────────────────────
 * Las URLs de media son firmadas y de vida corta (`NFR-008`): el mismo objeto
 * llega con un token distinto en cada pedido. Una clave derivada de la URL
 * fallaría el 100 % de las veces y la cache no ahorraría un solo transcode.
 * Entonces se hashea el archivo ya descargado. La consecuencia, dicha: **estas
 * tres operaciones siempre descargan**; lo que la cache ahorra es el transcode,
 * que es lo caro.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { z } from "zod";
import { RenderError } from "../errors.js";
import { probeCapabilities } from "../ffmpeg/capabilities.js";
import { isFastStart } from "../ffmpeg/faststart.js";
import { normalizeMedia, type ToneMappingResult } from "../ffmpeg/normalize.js";
import { mediaTypeOf, probeMedia, type MediaInfo } from "../ffmpeg/probe.js";
import { runFfmpeg } from "../ffmpeg/run.js";
import { planThumbnail } from "../ffmpeg/thumbnail.js";
import {
  assertMediaReferenceAllowed,
  mediaGrantSchema,
  verifyGrant,
} from "../media/urlPolicy.js";
import type { ArtifactExtension, CacheState, RenderEngineConfig } from "./engine.js";
import { engineVersion } from "./engineVersion.js";

/**
 * Lo único que `NFR-014` nombra como destino: «MOV→MP4». No se acepta otro
 * destino porque no hay otro que este servicio sepa producir, y aceptarlo para
 * devolver un MP4 igual sería mentirle al llamador sobre lo que pidió.
 */
export const NORMALIZE_TARGET_CONTENT_TYPE = "video/mp4";

/**
 * `NFR-013` topea los videos en 50 MB y las imágenes en 10 MB, y el rol decide
 * cuál se aplica. **El puerto no pasa rol**: `probe(url)` y `thumbnail({url,…})`
 * reciben una URL a secas y el medio puede ser cualquiera de los dos.
 *
 * Se usa `video`, el techo permisivo, para las tres operaciones. Rechazar una
 * imagen de 12 MB cuando lo único que se pidió fueron sus metadatos sería
 * aplicar el límite en el lugar equivocado: `NFR-013` protege el render, y el
 * render sí pide la media con su rol correcto (ver `engine.ts`). Estas tres
 * **informan o preparan**, no aceptan un upload.
 */
const MEDIA_ROLE = "video" as const;

const urlField = z.string().url();

export const probeOperationSchema = z
  .object({ url: urlField, grant: mediaGrantSchema.optional() })
  .strict();

export const normalizeOperationSchema = z
  .object({
    url: urlField,
    /** `NormalizeRequest.targetContentType` del puerto. */
    targetContentType: z.string().min(1),
    grant: mediaGrantSchema.optional(),
  })
  .strict();

export const thumbnailOperationSchema = z
  .object({
    url: urlField,
    /** `ThumbnailRequest.atSeconds`. Segundos desde el inicio. */
    atSeconds: z.number().nonnegative().finite().optional(),
    /** `ThumbnailRequest.maxWidth`. El mismo techo que un canvas. */
    maxWidth: z.number().int().min(16).max(4096),
    grant: mediaGrantSchema.optional(),
  })
  .strict();

export interface ProbeResponse {
  readonly contentType: string;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds?: number;
  readonly hasAudio: boolean;
  readonly isHdr: boolean;
  readonly isFastStart: boolean;
}

/** Lo que el adaptador necesita para armar un `RenderedMedia`, menos `body`. */
export interface MediaArtifactResponse {
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly width: number;
  readonly height: number;
  readonly durationSeconds?: number;
  /** Clave de cache. La capa HTTP la convierte en `href`; acá no hay URLs. */
  readonly cacheKey: string;
  readonly extension: ArtifactExtension;
  readonly cache: CacheState;
  readonly warnings: readonly string[];
}

export interface NormalizeResponse extends MediaArtifactResponse {
  /**
   * Qué hizo esta corrida. **Ausente en un cache hit**, porque en un hit no
   * hubo corrida: el artefacto salió del disco y el servicio no guarda qué se
   * hizo la primera vez. Reportar `needsRemux: false` ahí diría «no hizo falta
   * remuxear» de un archivo que se remuxeó, una vez. `cache: "hit"` ya dice
   * todo lo que el servicio sabe.
   */
  readonly normalization?: {
    readonly needsRemux: boolean;
    readonly needsTranscode: boolean;
    readonly toneMapping: ToneMappingResult;
  };
}

/* ------------------------------------------------------------------------ *
 * Piezas compartidas
 * ------------------------------------------------------------------------ */

function parseOperation<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new RenderError("bad_request", "el pedido no es válido", {
      details: {
        issues: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    });
  }
  return parsed.data as z.infer<T>;
}

/**
 * La misma política que `POST /render`, sin excepciones. Una ruta nueva que
 * acepta una URL y no pasa por acá es un agujero de `P2-RENDER-009` con otra
 * puerta: `RENDER_REQUIRE_GRANT=true` es el default del producto y tiene que
 * valer para las cuatro operaciones.
 */
function authorize(
  url: string,
  grant: z.infer<typeof mediaGrantSchema> | undefined,
  config: RenderEngineConfig,
): void {
  const verified = grant === undefined ? null : verifyGrant(grant, config.policy);
  assertMediaReferenceAllowed(
    { url, role: MEDIA_ROLE, path: ["url"] },
    config.policy,
    verified,
  );
}

/**
 * sha256 del archivo, en streaming. No se carga en memoria: un video de 50 MB
 * (`NFR-013`) en un buffer, por worker y por request, es exactamente el tipo de
 * pico que hace que `NFR-025` cuellee antes por RAM que por CPU.
 */
export async function hashFile(filePath: string): Promise<string> {
  const digest = createHash("sha256");
  await pipeline(createReadStream(filePath), digest);
  return digest.digest("hex");
}

/**
 * La clave del artefacto derivado. La versión del motor va adentro por la misma
 * razón que en `computeCacheKeys`: un upgrade que cambia los bytes de salida
 * tiene que dejar de acertar en la cache.
 *
 * Sale sha256 hex, que es lo único que `http/artifacts.ts` acepta como clave.
 */
function derivedKey(
  version: string,
  operation: string,
  sourceDigest: string,
  parameters: readonly string[],
): string {
  return createHash("sha256")
    .update([version, operation, sourceDigest, ...parameters].join("|"), "utf8")
    .digest("hex");
}

/** El `content-type` de destino, sin parámetros y en minúsculas. */
function essenceOf(contentType: string): string {
  const [essence] = contentType.split(";");
  return (essence ?? "").trim().toLowerCase();
}

/* ------------------------------------------------------------------------ *
 * `POST /probe` — `ERR-P11`
 * ------------------------------------------------------------------------ */

/**
 * Metadatos antes de aceptar un upload. De acá sale `ERR-P11` («We couldn't
 * read this video's details»): cuando ffprobe no puede leer el medio,
 * `probeMedia` tira `media_probe_failed` y eso es lo que el llamador traduce.
 */
export async function probeOperation(
  raw: unknown,
  config: RenderEngineConfig,
): Promise<ProbeResponse> {
  const request = parseOperation(probeOperationSchema, raw);
  authorize(request.url, request.grant, config);

  const localPath = await config.resolveMedia(request.url, MEDIA_ROLE);
  const info = await probeMedia(localPath);
  if (info.width === null || info.height === null) {
    throw new RenderError("unsupported_media_format", "el medio no declara dimensiones");
  }

  return {
    contentType: mediaTypeOf(info),
    width: info.width,
    height: info.height,
    // Una imagen fija reporta duración —un JPEG dice 0.04 s— y esa duración no
    // significa nada. Se omite: el puerto la tiene opcional justamente para
    // poder no decir nada en vez de decir algo falso.
    ...(info.isStillImage || info.durationSeconds === null
      ? {}
      : { durationSeconds: info.durationSeconds }),
    hasAudio: info.hasAudio,
    isHdr: info.isHdr,
    isFastStart: await isFastStart(localPath),
  };
}

/* ------------------------------------------------------------------------ *
 * `POST /normalize` — `NFR-014` / `P2-RENDER-013`
 * ------------------------------------------------------------------------ */

export async function normalizeOperation(
  raw: unknown,
  config: RenderEngineConfig,
): Promise<NormalizeResponse> {
  const request = parseOperation(normalizeOperationSchema, raw);
  if (essenceOf(request.targetContentType) !== NORMALIZE_TARGET_CONTENT_TYPE) {
    throw new RenderError("bad_request", "este servicio sólo normaliza a video/mp4", {
      details: {
        targetContentType: request.targetContentType,
        supported: [NORMALIZE_TARGET_CONTENT_TYPE],
      },
    });
  }
  authorize(request.url, request.grant, config);

  const caps = config.capabilities ?? (await probeCapabilities());
  const version = (await engineVersion(caps)).version;
  const localPath = await config.resolveMedia(request.url, MEDIA_ROLE);
  const sourceDigest = await hashFile(localPath);
  const key = derivedKey(version, "normalize", sourceDigest, [
    NORMALIZE_TARGET_CONTENT_TYPE,
    String(config.allowUntonemappedHdr),
  ]);

  const cached = await config.cache.get(key, "mp4");
  if (cached !== null) {
    const info = await probeMedia(cached.path);
    return {
      ...describeVideo(info, cached.bytes),
      cacheKey: cached.key,
      extension: "mp4",
      cache: "hit",
      // En un hit no se re-normaliza, así que no hay avisos que dar. Es la
      // misma asimetría que `POST /render` ya tiene documentada: el aviso
      // aparece una vez por contenido, no una vez por pedido. Con
      // `RENDER_ALLOW_UNTONEMAPPED_HDR=true` eso significa que un HDR sin tone
      // mapping avisa la primera vez y no la segunda.
      warnings: [],
    };
  }

  const workDir = await mkdtemp(path.join(tmpdir(), "fastgram-normalize-"));
  try {
    const outputPath = path.join(workDir, "normalized.mp4");
    const result = await normalizeMedia(localPath, outputPath, caps, {
      allowUntonemappedHdr: config.allowUntonemappedHdr,
    });
    const warnings: string[] = [];
    if (result.toneMapping === "unavailable") {
      warnings.push("HDR sin tone mapping: este build de ffmpeg no trae zscale");
    } else if (result.toneMapping === "approximate") {
      warnings.push("conversión de gama aproximada (BT.2020 SDR → BT.709)");
    }

    // Se mide la SALIDA, no la entrada: el transcode puede haber cambiado
    // dimensiones o duración, y el puerto pide los datos del artefacto que se
    // devuelve.
    const info = await probeMedia(outputPath);
    const entry = await config.cache.adopt(key, "mp4", outputPath);

    return {
      ...describeVideo(info, entry.bytes),
      cacheKey: entry.key,
      extension: "mp4",
      cache: "miss",
      warnings,
      normalization: {
        needsRemux: result.needsRemux,
        needsTranscode: result.needsTranscode,
        toneMapping: result.toneMapping,
      },
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

function describeVideo(
  info: MediaInfo,
  bytes: number,
): Omit<MediaArtifactResponse, "cacheKey" | "extension" | "cache" | "warnings"> {
  if (info.width === null || info.height === null) {
    throw new RenderError(
      "render_empty_output",
      "el medio normalizado no declara dimensiones",
    );
  }
  return {
    contentType: NORMALIZE_TARGET_CONTENT_TYPE,
    sizeBytes: bytes,
    width: info.width,
    height: info.height,
    ...(info.durationSeconds === null ? {} : { durationSeconds: info.durationSeconds }),
  };
}

/* ------------------------------------------------------------------------ *
 * `POST /thumbnail` — IMPL §5
 * ------------------------------------------------------------------------ */

export async function thumbnailOperation(
  raw: unknown,
  config: RenderEngineConfig,
): Promise<MediaArtifactResponse> {
  const request = parseOperation(thumbnailOperationSchema, raw);
  authorize(request.url, request.grant, config);

  const caps = config.capabilities ?? (await probeCapabilities());
  const version = (await engineVersion(caps)).version;
  const localPath = await config.resolveMedia(request.url, MEDIA_ROLE);
  const sourceDigest = await hashFile(localPath);

  const info = await probeMedia(localPath);
  const workDir = await mkdtemp(path.join(tmpdir(), "fastgram-thumbnail-"));
  try {
    const outputPath = path.join(workDir, "thumbnail.jpg");
    const plan = planThumbnail(
      info,
      {
        maxWidth: request.maxWidth,
        ...(request.atSeconds === undefined ? {} : { atSeconds: request.atSeconds }),
      },
      outputPath,
    );
    // La clave lleva el segundo YA ACOTADO, no el pedido: dos pedidos que caen
    // más allá del final del mismo video dan el mismo cuadro, y tienen que
    // compartir entrada de cache en vez de encodear dos veces lo mismo.
    const key = derivedKey(version, "thumbnail", sourceDigest, [
      String(plan.width),
      String(plan.height),
      plan.atSeconds === null ? "still" : plan.atSeconds.toFixed(3),
    ]);

    const cached = await config.cache.get(key, "jpg");
    if (cached !== null) {
      return {
        contentType: "image/jpeg",
        sizeBytes: cached.bytes,
        width: plan.width,
        height: plan.height,
        cacheKey: cached.key,
        extension: "jpg",
        cache: "hit",
        warnings: plan.warnings,
      };
    }

    await runFfmpeg(plan.args, { expectOutput: outputPath });
    const entry = await config.cache.adopt(key, "jpg", outputPath);
    return {
      contentType: "image/jpeg",
      sizeBytes: entry.bytes,
      width: plan.width,
      height: plan.height,
      cacheKey: entry.key,
      extension: "jpg",
      cache: "miss",
      warnings: plan.warnings,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
