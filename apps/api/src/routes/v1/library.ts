/**
 * Biblioteca **global** de assets — sprint 9 (agente N), `PU-S9-005/006`,
 * PRD §2.7 `D-19`. El contrato está en `@fastgram/contracts`
 * (`resources/library.ts`).
 *
 * ## Del dueño, salvo «usar en marca»
 *
 * Todas las rutas `/library/*` son owner-level (`isOwnerLevelRoute` en
 * `server/app.ts`) e ignoran `X-Fastgram-Workspace`: la biblioteca es de la
 * instalación. La excepción es `POST /library/assets/{id}/use-in-brand`, que
 * escribe en el Media Bank **de la marca activa** y por eso va con el scope
 * normal (RLS de la marca). Fuera del modo personal responden 404, como
 * `/workspaces` y `/character-models`: el día que haya multiusuario, importar
 * y editar la biblioteca común será de un rol de administración que hoy no
 * existe.
 *
 * ## La licencia se verifica del lado del servidor
 *
 * Importar de una fuente recibe **ids**, no URLs ni licencias: la API vuelve a
 * pedir cada archivo a la fuente, verifica la licencia con las funciones de
 * `@fastgram/core` (`library/sources.ts`) y sólo entonces crea la fila y
 * encola la bajada con el link que dio el proveedor. Lo que el cliente vio en
 * la búsqueda no se cree.
 *
 * ## Keys de Pexels y Pixabay
 *
 * En `${FASTGRAM_HOME}/library-sources.json` (`0600`, fuera del repo), como
 * `integrations.json`; si no, `PEXELS_API_KEY` / `PIXABAY_API_KEY` del
 * entorno. Nunca salen por la API ni a un log: la de Pixabay va en la query
 * (así lo pide su API), por eso esas URLs no se loguean.
 *
 * ## Decisiones que el PRD no cubre
 *
 * - **«Usar en marca» copia** el objeto a `media/{companyId}/library/…` (o
 *   `audio/{companyId}/library/…`) en vez de referenciar `library/`: borrar
 *   una media del Media Bank borra su objeto del bucket (`DELETE /media/:id`),
 *   y un `DELETE` de la marca no puede llevarse el asset global. Además el
 *   build de hoy firma `media/{companyId}/` y no `library/` (eso lo cablea la
 *   segunda tanda): una copia funciona ya. La licencia y el JSON viajan al
 *   sidecar `media-meta/{companyId}/{mediaId}.json` (campo `library`).
 * - El origen de la fila del Media Bank es `manual_upload` (como el import por
 *   link): un origen propio exige migrar el CHECK de `media`, que no es de
 *   esta tanda.
 * - La subida guarda la declaración de licencia en un sidecar
 *   `library/uploads/{uploadId}.declaration.json` entre la reserva y la
 *   confirmación: sin fila hasta que el objeto llegó (una reserva abandonada
 *   no deja un asset `processing` para siempre).
 */
import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { canonicalObjectUrl, resolveFastgramHome } from "@fastgram/adapters";
import {
  BYTES_PER_MB,
  LIBRARY_KIND_MEDIA_CATEGORY,
  LIBRARY_SOURCES,
  brandAudioKeyPrefix,
  libraryAssetMetadataSchema,
  libraryLicenseSchema,
  libraryUploadRequestSchema,
  librarySearchQuerySchema,
  librarySourceIdSchema,
  librarySourceImportRequestSchema,
  listLibraryAssetsQuerySchema,
  setLibrarySourceKeyRequestSchema,
  updateLibraryAssetRequestSchema,
  type FastgramMode,
  type LibraryAsset,
  type LibraryAssetKind,
  type LibraryAssetMetadata,
  type LibraryLicense,
  type LibraryLicenseDeclaration,
  type LibrarySearchResult,
  type LibrarySourceId,
  type LibrarySourceImportOutcome,
  type LibrarySourceStatus,
  type LibraryUseInBrandResult,
} from "@fastgram/contracts";
import {
  JOB_QUEUES,
  LIBRARY_SOURCE_INFO,
  LIBRARY_UPLOAD_PREFIX,
  buildLibrarySearchText,
  libraryImportSingletonKey,
  mediaMetaKey,
  parsePexelsResponse,
  parsePixabayResponse,
  parseWikimediaResponse,
  pexelsSearchUrl,
  pexelsVideoUrl,
  pixabaySearchUrl,
  pixabayVideoUrl,
  wikimediaFileUrl,
  wikimediaSearchUrl,
  type LibraryImportJob,
  type SourceCandidate,
  type SourcePage,
} from "@fastgram/core";
import {
  addMediaTag,
  brandAudioRepository,
  libraryAssetRepository,
  mediaRepository,
  uploadReservationRepository,
  withoutCompany,
  type LibraryAssetRow,
  type Transaction,
} from "@fastgram/db";
import { PortError, type Queue } from "@fastgram/ports";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import { ApiRejection } from "../../http/errors.js";
import { rateLimit } from "../../plugins/rate-limit.js";
import { claimReservation, reserveUpload } from "../../support/upload-reservations.js";
import { sendRejection } from "./media.js";
import { data, notFound, page } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idParams = z.object({ id: z.string().min(1) });
const uploadParams = z.object({ upload: z.string().min(1) });
const sourceParams = z.object({ source: z.string().min(1) });

/** El User-Agent que pide la política de Wikimedia (descriptivo, sin datos del dueño). */
const USER_AGENT = "FastGram/1.0 (self-hosted content tool; library import)";
const SOURCE_TIMEOUT_MS = 20_000;
/** Pixabay exige cachear los resultados 24 h (`pixabay.com/api/docs`). */
const PIXABAY_CACHE_MS = 24 * 60 * 60 * 1000;
const PIXABAY_CACHE_MAX = 200;

// --- Keys de las fuentes -----------------------------------------------------

export const LIBRARY_SOURCES_FILE = "library-sources.json";
const KEY_ENV: Readonly<Record<"pexels" | "pixabay", string>> = {
  pexels: "PEXELS_API_KEY",
  pixabay: "PIXABAY_API_KEY",
};

type Env = Readonly<Record<string, string | undefined>>;
type KeyedSource = "pexels" | "pixabay";
const isKeyed = (s: LibrarySourceId): s is KeyedSource =>
  s === "pexels" || s === "pixabay";

interface SourceKeysFile {
  readonly version: 1;
  readonly keys: { readonly [K in KeyedSource]?: string | undefined };
}

function sourcesPath(env: Env): string {
  return join(resolveFastgramHome(env), LIBRARY_SOURCES_FILE);
}

async function readKeysFile(env: Env): Promise<SourceKeysFile> {
  let raw: string;
  try {
    raw = await readFile(sourcesPath(env), "utf8");
  } catch (cause) {
    if ((cause as { code?: unknown }).code === "ENOENT") return { version: 1, keys: {} };
    throw cause;
  }
  const parsed = z
    .object({
      version: z.literal(1),
      keys: z
        .object({
          pexels: z.string().min(1).optional(),
          pixabay: z.string().min(1).optional(),
        })
        .strict(),
    })
    .strict()
    .safeParse(JSON.parse(raw) as unknown);
  // Un archivo roto no se repara ni se pisa (puede tener la única copia de la key).
  if (!parsed.success) {
    throw new ApiRejection(
      503,
      "service_unavailable",
      `${LIBRARY_SOURCES_FILE} has an unexpected shape. Fix or delete it.`,
    );
  }
  return parsed.data;
}

async function writeKeysFile(env: Env, file: SourceKeysFile): Promise<void> {
  const target = sourcesPath(env);
  const tmp = `${target}.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    await writeFile(tmp, `${JSON.stringify(file, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await chmod(tmp, 0o600);
    await rename(tmp, target);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

async function keyFor(
  env: Env,
  source: LibrarySourceId,
): Promise<{ key: string; from: "file" | "env" } | null> {
  if (!isKeyed(source)) return null;
  const file = (await readKeysFile(env)).keys[source];
  if (file !== undefined) return { key: file, from: "file" };
  const fromEnv = env[KEY_ENV[source]]?.trim();
  return fromEnv === undefined || fromEnv === "" ? null : { key: fromEnv, from: "env" };
}

async function sourceStatus(
  env: Env,
  source: LibrarySourceId,
): Promise<LibrarySourceStatus> {
  const info = LIBRARY_SOURCE_INFO[source];
  const key = info.needsKey ? await keyFor(env, source) : null;
  const enabled = !info.needsKey || key !== null;
  return {
    id: source,
    label: info.label,
    licenseUrl: info.licenseUrl,
    needsKey: info.needsKey,
    enabled,
    disabledReason: enabled ? null : "missing_key",
    keyFrom: key?.from ?? null,
  };
}

// --- HTTP a las fuentes ------------------------------------------------------

export type LibrarySourceFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface LibraryRouteDeps {
  /** Se lee en cada pedido: `FASTGRAM_HOME` y las keys del entorno. */
  readonly env: Env;
  readonly fetch: LibrarySourceFetch;
}

export function defaultLibraryRouteDeps(env: Env = process.env): LibraryRouteDeps {
  return { env, fetch: (url, init) => fetch(url, init) };
}

async function fetchSourceJson(
  deps: LibraryRouteDeps,
  source: LibrarySourceId,
  url: string,
  headers: Record<string, string> = {},
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SOURCE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await deps.fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json", ...headers },
      signal: controller.signal,
    });
  } catch {
    throw sourceUnavailable(source, "source_unreachable");
  } finally {
    clearTimeout(timer);
  }
  // El cuerpo de un error del proveedor no se lee ni se propaga.
  if (response.status === 401 || response.status === 403 || response.status === 400) {
    throw sourceUnavailable(
      source,
      isKeyed(source) ? "source_rejected_key" : "source_rejected",
    );
  }
  if (response.status === 429) throw sourceUnavailable(source, "source_rate_limited");
  if (response.status === 404) return null;
  if (!response.ok) throw sourceUnavailable(source, "source_unreachable");
  try {
    return (await response.json()) as unknown;
  } catch {
    throw sourceUnavailable(source, "source_bad_response");
  }
}

function sourceUnavailable(source: LibrarySourceId, reason: string): ApiRejection {
  return new ApiRejection(
    503,
    "service_unavailable",
    `${LIBRARY_SOURCE_INFO[source].label} didn't answer as expected. Try again later.`,
    { reason, source },
  );
}

// --- Vistas ------------------------------------------------------------------

export function toLibraryAsset(row: LibraryAssetRow): LibraryAsset {
  const license = libraryLicenseSchema.parse(row.license);
  const metadata =
    row.metadata === null ? null : libraryAssetMetadataSchema.safeParse(row.metadata);
  return {
    id: row.id,
    title: row.title,
    kind: row.kind as LibraryAssetKind,
    mediaType: row.mediaType as LibraryAsset["mediaType"],
    status: row.status,
    url: row.url,
    previewUrl: row.previewUrl,
    contentType: row.contentType,
    sizeMb: row.sizeMb,
    durationSec: row.durationSec,
    width: row.width,
    height: row.height,
    license,
    // Un JSON guardado que ya no valida (contrato más estricto) sale como `null`
    // en vez de romper la lista: el asset se ve y se puede re-editar.
    metadata: metadata?.success === true ? metadata.data : null,
    metadataSource: row.metadataSource === "edited" ? "edited" : "auto",
    provider: row.provider as LibraryAsset["provider"],
    externalId: row.externalId,
    failureCode: (row.failureCode as LibraryAsset["failureCode"]) ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toSearchResult(
  c: SourceCandidate,
  existing: ReadonlyMap<string, string>,
): LibrarySearchResult {
  return {
    source: c.source,
    externalId: c.externalId,
    title: c.title,
    pageUrl: c.pageUrl,
    previewUrl: c.previewUrl,
    mediaType: c.mediaType,
    durationSec: c.durationSec,
    width: c.width,
    height: c.height,
    sizeMb: c.sizeBytes === null ? null : c.sizeBytes / BYTES_PER_MB,
    licenseLabel: c.licenseLabel,
    license: c.license,
    importable: c.rejection === null,
    unimportableReason: c.rejection,
    existingAssetId: existing.get(c.pageUrl) ?? null,
  };
}

/** Qué tipos son de qué medio: editar el tipo no puede cambiar el medio. */
const KIND_MEDIA: Readonly<Record<LibraryAssetKind, "video" | "image" | "audio">> = {
  green_screen_video: "video",
  background_video: "video",
  background_image: "image",
  image: "image",
  audio: "audio",
};

function defaultKind(mediaType: "video" | "image" | "audio"): LibraryAssetKind {
  return mediaType === "video"
    ? "background_video"
    : mediaType === "image"
      ? "image"
      : "audio";
}

function titleFromFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? filename;
  const dot = base.lastIndexOf(".");
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim();
  return (stem === "" ? "Untitled asset" : stem).slice(0, 200);
}

async function readAllBytes(stream: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
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

const declarationKey = (uploadId: string): string =>
  `${LIBRARY_UPLOAD_PREFIX}/${uploadId}.declaration.json`;

/** La declaración del formulario + la fecha → una licencia que valida, o 400. */
function licenseFromDeclaration(
  decl: LibraryLicenseDeclaration,
  verifiedAt: string,
): LibraryLicense {
  const parsed = libraryLicenseSchema.safeParse({ ...decl, verifiedAt });
  if (!parsed.success) {
    throw new ApiRejection(400, "bad_request", "The license declaration is incomplete.", {
      field: "license",
      issues: parsed.error.issues.map((i) => ["license", ...i.path].join(".")),
    });
  }
  return parsed.data;
}

// --- Rutas -------------------------------------------------------------------

export function registerLibraryRoutes(
  app: ZodApp,
  deps: LibraryRouteDeps = defaultLibraryRouteDeps(),
): void {
  const { db, storage, clock, limiter, queue } = app.deps;
  const mode: FastgramMode = app.deps.mode ?? "standard";
  const pixabayCache = new Map<string, { at: number; body: unknown }>();

  const requirePersonal = (): void => {
    if (mode !== "personal") throw notFound("route");
  };
  const homeCompanyOf = (request: FastifyRequest): string =>
    request.auth.homeCompanyId ?? request.auth.companyId;
  const nowIso = (): string => new Date(clock.nowMs()).toISOString();

  function requireQueue(): Queue {
    if (queue === undefined) {
      throw new ApiRejection(
        503,
        "service_unavailable",
        "Importing into the library is temporarily unavailable.",
      );
    }
    return queue;
  }

  async function findAsset(id: string): Promise<LibraryAssetRow> {
    if (!UUID.test(id)) throw notFound("library asset");
    const row = await withoutCompany(db, (tx) => libraryAssetRepository.findById(tx, id));
    if (row === null) throw notFound("library asset");
    return row;
  }

  function parseSource(raw: string): LibrarySourceId {
    const parsed = librarySourceIdSchema.safeParse(raw);
    if (!parsed.success) throw notFound("library source");
    return parsed.data;
  }

  async function enabledKey(source: LibrarySourceId): Promise<string | null> {
    const info = LIBRARY_SOURCE_INFO[source];
    if (!info.needsKey) return null;
    const key = await keyFor(deps.env, source);
    if (key === null) {
      throw new ApiRejection(409, "conflict", `Add a ${info.label} API key first.`, {
        reason: "missing_key",
        source,
      });
    }
    return key.key;
  }

  async function searchSource(
    source: LibrarySourceId,
    q: string,
    pageNo: number,
  ): Promise<SourcePage> {
    const verifiedAt = nowIso();
    const key = await enabledKey(source);
    if (source === "wikimedia") {
      return parseWikimediaResponse(
        await fetchSourceJson(deps, source, wikimediaSearchUrl(q, pageNo)),
        verifiedAt,
        pageNo,
      );
    }
    if (source === "pexels") {
      return parsePexelsResponse(
        await fetchSourceJson(deps, source, pexelsSearchUrl(q, pageNo), {
          authorization: key ?? "",
        }),
        verifiedAt,
        pageNo,
      );
    }
    const cacheKey = `${q.toLowerCase()}|${String(pageNo)}`;
    const hit = pixabayCache.get(cacheKey);
    let body: unknown;
    if (hit !== undefined && clock.nowMs() - hit.at < PIXABAY_CACHE_MS) {
      body = hit.body;
    } else {
      body = await fetchSourceJson(deps, source, pixabaySearchUrl(key ?? "", q, pageNo));
      if (pixabayCache.size >= PIXABAY_CACHE_MAX) {
        const oldest = pixabayCache.keys().next().value;
        if (oldest !== undefined) pixabayCache.delete(oldest);
      }
      pixabayCache.set(cacheKey, { at: clock.nowMs(), body });
    }
    return parsePixabayResponse(body, verifiedAt, pageNo);
  }

  /** El archivo, pedido de nuevo a la fuente (la verificación es del servidor). */
  async function fetchOne(
    source: LibrarySourceId,
    externalId: string,
  ): Promise<SourceCandidate | null> {
    const verifiedAt = nowIso();
    const key = await enabledKey(source);
    let found: SourcePage;
    if (source === "wikimedia") {
      if (!/^File:/i.test(externalId)) return null;
      found = parseWikimediaResponse(
        await fetchSourceJson(deps, source, wikimediaFileUrl(externalId)),
        verifiedAt,
      );
    } else if (source === "pexels") {
      if (!/^\d{1,15}$/.test(externalId)) return null;
      found = parsePexelsResponse(
        await fetchSourceJson(deps, source, pexelsVideoUrl(externalId), {
          authorization: key ?? "",
        }),
        verifiedAt,
      );
    } else {
      if (!/^\d{1,15}$/.test(externalId)) return null;
      found = parsePixabayResponse(
        await fetchSourceJson(deps, source, pixabayVideoUrl(key ?? "", externalId)),
        verifiedAt,
      );
    }
    return found.candidates.find((c) => c.externalId === externalId) ?? null;
  }

  // ── GET /library/assets ──
  app.get(
    "/library/assets",
    { schema: { querystring: listLibraryAssetsQuerySchema } },
    async (request) => {
      requirePersonal();
      const q = request.query;
      const result = await withoutCompany(db, (tx) =>
        libraryAssetRepository.list(tx, {
          ...(q.q === undefined ? {} : { q: q.q }),
          ...(q.kind === undefined ? {} : { kinds: q.kind }),
          ...(q.memeType === undefined ? {} : { memeTypes: q.memeType }),
          ...(q.emotion === undefined ? {} : { emotions: q.emotion }),
          ...(q.aspect === undefined ? {} : { aspects: q.aspect }),
          ...(q.license === undefined ? {} : { licenseTypes: q.license }),
          ...(q.minDuration === undefined ? {} : { minDurationSec: q.minDuration }),
          ...(q.maxDuration === undefined ? {} : { maxDurationSec: q.maxDuration }),
          ...(q.status === undefined ? {} : { statuses: q.status }),
          ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
          limit: q.limit,
        }),
      );
      return page(result, toLibraryAsset);
    },
  );

  // ── GET /library/assets/:id ──
  app.get("/library/assets/:id", { schema: { params: idParams } }, async (request) => {
    requirePersonal();
    return data(toLibraryAsset(await findAsset(request.params.id)));
  });

  // ── PATCH /library/assets/:id ──
  app.patch(
    "/library/assets/:id",
    {
      schema: { params: idParams, body: updateLibraryAssetRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request) => {
      requirePersonal();
      const row = await findAsset(request.params.id);
      const body = request.body;
      const current =
        row.metadata === null ? null : libraryAssetMetadataSchema.safeParse(row.metadata);
      const { hidden, title, ...edits } = body;
      const touchesMetadata = Object.keys(edits).length > 0;
      if (touchesMetadata && (current === null || !current.success)) {
        throw new ApiRejection(409, "conflict", "This asset is still processing.", {
          reason: row.status === "failed" ? "failed" : "processing",
        });
      }
      if (hidden !== undefined && row.status !== "ready" && row.status !== "hidden") {
        throw new ApiRejection(409, "conflict", "Only a ready asset can be hidden.", {
          reason: row.status,
        });
      }
      if (edits.kind !== undefined && KIND_MEDIA[edits.kind] !== row.mediaType) {
        throw new ApiRejection(400, "bad_request", "That type doesn't match the file.", {
          field: "kind",
        });
      }
      let metadata: LibraryAssetMetadata | null =
        current !== null && current.success ? current.data : null;
      if (touchesMetadata && metadata !== null) {
        const merged = libraryAssetMetadataSchema.safeParse({
          ...metadata,
          ...Object.fromEntries(Object.entries(edits).filter(([, v]) => v !== undefined)),
          // Lo que el dueño revisó deja de estar pendiente.
          needsReview: false,
        });
        if (!merged.success) {
          throw new ApiRejection(400, "bad_request", "Those metadata don't validate.", {
            issues: merged.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
          });
        }
        metadata = merged.data;
      }
      const nextTitle = title ?? row.title;
      const updated = await withoutCompany(db, (tx) =>
        libraryAssetRepository.update(tx, row.id, {
          title: nextTitle,
          ...(touchesMetadata && metadata !== null
            ? { metadata, metadataSource: "edited", kind: metadata.kind }
            : {}),
          ...(hidden === undefined ? {} : { status: hidden ? "hidden" : "ready" }),
          searchText: buildLibrarySearchText(nextTitle, metadata),
        }),
      );
      if (updated === null) throw notFound("library asset");
      return data(toLibraryAsset(updated));
    },
  );

  // ── DELETE /library/assets/:id ──
  app.delete(
    "/library/assets/:id",
    { schema: { params: idParams } },
    async (request, reply) => {
      requirePersonal();
      const row = await findAsset(request.params.id);
      // Soft delete: el objeto queda (las copias de cada marca son independientes).
      await withoutCompany(db, (tx) => libraryAssetRepository.softDelete(tx, row.id));
      request.log.info({ assetId: row.id }, "library asset deleted");
      return reply.status(204).send();
    },
  );

  // ── POST /library/assets/uploads ──
  app.post(
    "/library/assets/uploads",
    {
      schema: { body: libraryUploadRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      requirePersonal();
      const body = request.body;
      // Se valida ahora (400 antes de subir 200 MB) y otra vez al confirmar.
      licenseFromDeclaration(body.license, nowIso());
      const companyId = homeCompanyOf(request);
      const reservation = await request.tx((tx) =>
        reserveUpload({
          tx,
          storage,
          companyId,
          apiKeyId: request.auth.apiKeyId,
          prefix: LIBRARY_UPLOAD_PREFIX,
          filename: body.filename,
          contentType: body.contentType,
          sizeBytes: body.sizeBytes,
        }),
      );
      await storage.put({
        key: declarationKey(reservation.uploadId),
        body: new TextEncoder().encode(
          JSON.stringify({
            license: body.license,
            ...(body.title === undefined ? {} : { title: body.title }),
            ...(body.kind === undefined ? {} : { kind: body.kind }),
          }),
        ),
        contentType: "application/json",
        cacheControl: "no-store",
      });
      // `uploadUrl` está firmada: no va a logs.
      return reply.status(201).send(data(reservation));
    },
  );

  // ── POST /library/assets/uploads/:upload/complete ──
  // (El parámetro no termina en `Id` a propósito: trampa 56.)
  app.post(
    "/library/assets/uploads/:upload/complete",
    {
      schema: { params: uploadParams },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      requirePersonal();
      const jobs = requireQueue();
      const uploadId = request.params.upload;
      if (!UUID.test(uploadId)) throw notFound("upload reservation");
      const companyId = homeCompanyOf(request);

      let declaration: {
        license: LibraryLicenseDeclaration;
        title?: string;
        kind?: LibraryAssetKind;
      } | null = null;
      try {
        const raw = JSON.parse(
          new TextDecoder().decode(
            await readAllBytes(await storage.get(declarationKey(uploadId))),
          ),
        ) as unknown;
        const parsed = z
          .object({
            license: libraryUploadRequestSchema.innerType().shape.license,
            title: z.string().min(1).max(200).optional(),
            kind: libraryUploadRequestSchema.innerType().shape.kind,
          })
          .strict()
          .safeParse(raw);
        if (parsed.success) {
          declaration = {
            license: parsed.data.license,
            ...(parsed.data.title === undefined ? {} : { title: parsed.data.title }),
            ...(parsed.data.kind === undefined ? {} : { kind: parsed.data.kind }),
          };
        }
      } catch (error) {
        if (!(error instanceof PortError && error.code === "not_found")) throw error;
      }
      // Sin declaración no hay licencia: la reserva no es de la biblioteca.
      if (declaration === null) throw notFound("upload reservation");
      const license = licenseFromDeclaration(declaration.license, nowIso());

      const outcome = await request.tx(async (tx: Transaction) => {
        const claim = await claimReservation({
          tx,
          storage,
          companyId,
          uploadId,
          nowMs: clock.nowMs(),
        });
        if (!claim.ok) return claim;
        const reservation = claim.row;
        if (!reservation.storageKey.startsWith(`${LIBRARY_UPLOAD_PREFIX}/`)) {
          return {
            ok: false as const,
            rejection: {
              status: 404 as const,
              code: "not_found" as const,
              message: "upload reservation not found",
            },
          };
        }
        const mediaType = reservation.contentType.startsWith("video/")
          ? "video"
          : reservation.contentType.startsWith("image/")
            ? "image"
            : "audio";
        const row = await libraryAssetRepository.create(tx, {
          title: declaration.title ?? titleFromFilename(reservation.filename),
          kind: declaration.kind ?? defaultKind(mediaType),
          mediaType,
          status: "processing",
          provider: "upload",
          license,
          licenseType: license.type,
          licenseSourceUrl: license.sourceUrl ?? null,
          searchText: declaration.title ?? titleFromFilename(reservation.filename),
          importedByCompanyId: companyId,
        });
        if (row === null) {
          return {
            ok: false as const,
            rejection: {
              status: 409 as const,
              code: "conflict" as const,
              message: "That source is already in the library.",
            },
          };
        }
        await uploadReservationRepository.update(tx, { companyId }, uploadId, {
          state: "committed",
        });
        const job: LibraryImportJob = {
          assetId: row.id,
          origin: {
            kind: "upload",
            storageKey: reservation.storageKey,
            contentType: reservation.contentType,
          },
          ...(declaration.kind === undefined ? {} : { kindHint: declaration.kind }),
        };
        await jobs.enqueue<LibraryImportJob>({
          queue: JOB_QUEUES.libraryImport,
          payload: job,
          options: {
            transaction: tx,
            singletonKey: libraryImportSingletonKey(row.id),
            retryLimit: 1,
            retryBackoff: true,
          },
        });
        return { ok: true as const, row };
      });
      if (!outcome.ok) return sendRejection(reply, outcome.rejection);
      await storage.delete(declarationKey(uploadId)).catch(() => undefined);
      return reply.status(202).send(data(toLibraryAsset(outcome.row)));
    },
  );

  // ── POST /library/assets/:id/use-in-brand ── (de la marca activa)
  app.post(
    "/library/assets/:id/use-in-brand",
    {
      schema: { params: idParams },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      requirePersonal();
      const row = await findAsset(request.params.id);
      if (row.status !== "ready" || row.storageKey === null || row.metadata === null) {
        throw new ApiRejection(409, "conflict", "This asset isn't ready yet.", {
          reason: row.status,
        });
      }
      const companyId = request.auth.companyId;
      const kind = row.kind as LibraryAssetKind;
      const license = libraryLicenseSchema.parse(row.license);
      const metadata = libraryAssetMetadataSchema.parse(row.metadata);
      const extension = row.storageKey.split(".").pop() ?? "bin";
      const newId = randomUUID();
      const targetKey =
        kind === "audio"
          ? `${brandAudioKeyPrefix(companyId)}/library/${newId}.${extension}`
          : `media/${companyId}/library/${newId}.${extension}`;
      const head = await storage.head(row.storageKey);
      if (head === null) {
        throw new ApiRejection(
          409,
          "conflict",
          "The asset's file is missing from storage.",
          {
            reason: "missing_object",
          },
        );
      }
      const stored = await storage.put({
        key: targetKey,
        body: await readAllBytes(await storage.get(row.storageKey)),
        contentType: head.contentType,
      });
      const url = await canonicalObjectUrl(storage, stored.key);
      const sizeMb = stored.sizeBytes / BYTES_PER_MB;

      let result: LibraryUseInBrandResult;
      try {
        if (kind === "audio") {
          const track = await request.tx((tx) =>
            brandAudioRepository.create(
              tx,
              { companyId },
              {
                title: row.title.slice(0, 200),
                origin: "import",
                storageKey: stored.key,
                url,
                contentType: head.contentType,
                sizeMb,
                ...(row.durationSec === null ? {} : { durationSec: row.durationSec }),
                ...(license.sourceUrl === undefined
                  ? {}
                  : { sourceUrl: license.sourceUrl }),
              },
            ),
          );
          result = { assetId: row.id, target: "audio", targetId: track.id, url };
        } else {
          await request.tx(async (tx) => {
            await mediaRepository.create(
              tx,
              { companyId },
              {
                mediaId: newId,
                mediaType: row.mediaType === "video" ? "video" : "image",
                filename: `${row.title.slice(0, 180)}.${extension}`,
                r2Url: url,
                storageKey: stored.key,
                // Ya está normalizado (lo hizo el import de la biblioteca).
                status: "ready",
                sizeMb,
                ...(row.mediaType === "video" && row.durationSec !== null
                  ? { videoDurationSec: Math.round(row.durationSec) }
                  : {}),
                categories: [LIBRARY_KIND_MEDIA_CATEGORY[kind]],
                origin: "manual_upload",
              },
            );
            for (const tag of metadata.tags.slice(0, 10)) {
              await addMediaTag(tx, { companyId }, newId, tag.toLowerCase());
            }
          });
          result = { assetId: row.id, target: "media", targetId: newId, url };
          // La procedencia viaja al sidecar que ya lee `GET /media/meta`.
          await storage
            .put({
              key: mediaMetaKey(companyId, newId),
              body: new TextEncoder().encode(
                JSON.stringify({
                  mediaId: newId,
                  ...(license.sourceUrl === undefined
                    ? {}
                    : { sourceUrl: license.sourceUrl }),
                  ...(metadata.chroma.type === "green" || metadata.chroma.type === "blue"
                    ? { background: "green_screen" }
                    : {}),
                  library: { assetId: row.id, license, metadata },
                }),
              ),
              contentType: "application/json",
              cacheControl: "no-store",
            })
            .catch((error: unknown) => {
              request.log.warn(
                { err: error instanceof Error ? error.name : "unknown" },
                "no se pudo guardar la procedencia del asset en la marca",
              );
            });
        }
      } catch (error) {
        // Sin fila, la copia es un huérfano: se borra.
        await storage.delete(stored.key).catch(() => undefined);
        throw error;
      }
      request.log.info(
        { assetId: row.id, target: result.target },
        "library asset used in brand",
      );
      return reply.status(201).send(data(result));
    },
  );

  // ── GET /library/sources ──
  app.get("/library/sources", async () => {
    requirePersonal();
    return data(await Promise.all(LIBRARY_SOURCES.map((s) => sourceStatus(deps.env, s))));
  });

  // ── PUT /library/sources/:source/key ──
  app.put(
    "/library/sources/:source/key",
    { schema: { params: sourceParams, body: setLibrarySourceKeyRequestSchema } },
    async (request) => {
      requirePersonal();
      const source = parseSource(request.params.source);
      if (!isKeyed(source)) {
        throw new ApiRejection(400, "bad_request", "This source doesn't need a key.", {
          field: "source",
        });
      }
      const current = await readKeysFile(deps.env);
      await writeKeysFile(deps.env, {
        version: 1,
        keys: { ...current.keys, [source]: request.body.apiKey },
      });
      request.log.info({ source }, "library source key saved");
      return data(await sourceStatus(deps.env, source));
    },
  );

  // ── DELETE /library/sources/:source/key ──
  app.delete(
    "/library/sources/:source/key",
    { schema: { params: sourceParams } },
    async (request) => {
      requirePersonal();
      const source = parseSource(request.params.source);
      if (isKeyed(source)) {
        const current = await readKeysFile(deps.env);
        const keys = { ...current.keys };
        delete keys[source];
        await writeKeysFile(deps.env, { version: 1, keys });
      }
      return data(await sourceStatus(deps.env, source));
    },
  );

  // ── GET /library/sources/:source/search ──
  app.get(
    "/library/sources/:source/search",
    { schema: { params: sourceParams, querystring: librarySearchQuerySchema } },
    async (request) => {
      requirePersonal();
      const source = parseSource(request.params.source);
      const { q, page: pageNo } = request.query;
      const found = await searchSource(source, q, pageNo);
      const existing = await withoutCompany(db, (tx) =>
        libraryAssetRepository.findBySourceUrls(
          tx,
          found.candidates.map((c) => c.pageUrl),
        ),
      );
      const byUrl = new Map(
        existing
          .filter((r) => r.licenseSourceUrl !== null)
          .map((r) => [r.licenseSourceUrl as string, r.id]),
      );
      return data({
        results: found.candidates.map((c) => toSearchResult(c, byUrl)),
        nextPage: found.nextPage,
        credit: LIBRARY_SOURCE_INFO[source].credit,
      });
    },
  );

  // ── POST /library/sources/:source/import ──
  app.post(
    "/library/sources/:source/import",
    {
      schema: { params: sourceParams, body: librarySourceImportRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      requirePersonal();
      const jobs = requireQueue();
      const source = parseSource(request.params.source);
      const { externalIds, kind } = request.body;
      const companyId = homeCompanyOf(request);
      const outcomes: LibrarySourceImportOutcome[] = [];
      for (const externalId of [...new Set(externalIds)]) {
        const candidate = await fetchOne(source, externalId);
        if (candidate === null) {
          outcomes.push({
            externalId,
            outcome: "rejected",
            assetId: null,
            reason: "not_found",
          });
          continue;
        }
        const license =
          candidate.license === null
            ? null
            : libraryLicenseSchema.safeParse(candidate.license);
        if (candidate.rejection !== null || license === null || !license.success) {
          outcomes.push({
            externalId,
            outcome: "rejected",
            assetId: null,
            reason: candidate.rejection ?? "license_unverifiable",
          });
          continue;
        }
        const verified = license.data;
        const created = await withoutCompany(db, async (tx) => {
          const row = await libraryAssetRepository.create(tx, {
            title: candidate.title,
            kind: kind ?? defaultKind(candidate.mediaType),
            mediaType: candidate.mediaType,
            status: "processing",
            provider: source,
            externalId: candidate.externalId,
            license: verified,
            licenseType: verified.type,
            licenseSourceUrl: candidate.pageUrl,
            searchText: candidate.title,
            importedByCompanyId: companyId,
          });
          if (row === null) return null;
          const job: LibraryImportJob = {
            assetId: row.id,
            origin: {
              kind: "remote",
              source,
              downloadUrl: candidate.downloadUrl,
              mime: candidate.mime,
            },
            ...(kind === undefined ? {} : { kindHint: kind }),
          };
          await jobs.enqueue<LibraryImportJob>({
            queue: JOB_QUEUES.libraryImport,
            payload: job,
            options: {
              transaction: tx,
              singletonKey: libraryImportSingletonKey(row.id),
              retryLimit: 1,
              retryBackoff: true,
            },
          });
          return row;
        });
        if (created === null) {
          const [existing] = await withoutCompany(db, (tx) =>
            libraryAssetRepository.findBySourceUrls(tx, [candidate.pageUrl]),
          );
          // Un import que falló (p. ej. la fuente contestó 429) se reintenta
          // importándolo otra vez: misma fila, job nuevo. La clave del
          // singleton lleva el instante (trampa 39: una clave fija dispara
          // una sola vez en la vida).
          if (existing !== undefined && existing.status === "failed") {
            await withoutCompany(db, async (tx) => {
              await libraryAssetRepository.update(tx, existing.id, {
                status: "processing",
                failureCode: null,
              });
              const job: LibraryImportJob = {
                assetId: existing.id,
                origin: {
                  kind: "remote",
                  source,
                  downloadUrl: candidate.downloadUrl,
                  mime: candidate.mime,
                },
                ...(kind === undefined ? {} : { kindHint: kind }),
              };
              await jobs.enqueue<LibraryImportJob>({
                queue: JOB_QUEUES.libraryImport,
                payload: job,
                options: {
                  transaction: tx,
                  singletonKey: `${libraryImportSingletonKey(existing.id)}:${String(clock.nowMs())}`,
                  retryLimit: 1,
                  retryBackoff: true,
                },
              });
            });
            outcomes.push({
              externalId,
              outcome: "queued",
              assetId: existing.id,
              reason: null,
            });
            continue;
          }
          outcomes.push({
            externalId,
            outcome: "duplicate",
            assetId: existing?.id ?? null,
            reason: null,
          });
          continue;
        }
        outcomes.push({
          externalId,
          outcome: "queued",
          assetId: created.id,
          reason: null,
        });
      }
      request.log.info(
        {
          source,
          queued: outcomes.filter((o) => o.outcome === "queued").length,
          rejected: outcomes.filter((o) => o.outcome === "rejected").length,
        },
        "library source import",
      );
      return reply.status(202).send(data(outcomes));
    },
  );
}
