/**
 * `P2-RENDER-009` — Toda URL de media debe pertenecer al Media Bank del
 * workspace o a la librería compartida. Una URL arbitraria se rechaza con
 * `400 bad_request` ANTES de iniciar el build (`FR-070`). El audio sólo puede
 * venir de la librería compartida.
 *
 * ── La decisión, y por qué ───────────────────────────────────────────────────
 * Este servicio es SIN ESTADO: no tiene base, no puede preguntar si el asset
 * `abc` es del workspace 42. Si igual intentara resolverlo (por ejemplo yendo a
 * buscar la URL), estaría confiando en la URL misma, que es justo lo que hay
 * que no confiar.
 *
 * Entonces la autoridad vive afuera y llega de dos formas, y se exige AL MENOS
 * UNA, con **denegación por defecto**:
 *
 *  1. **Configuración** — `RENDER_ALLOWED_MEDIA_PREFIXES` y
 *     `RENDER_SHARED_LIBRARY_PREFIXES`: los prefijos (origen + ruta) del bucket
 *     propio y del catálogo compartido. Es el piso: aunque el grant mienta, una
 *     URL fuera de estos prefijos no entra.
 *  2. **Grant firmado en el payload** — el servicio que sí tiene base (la API)
 *     firma con HMAC-SHA256 un grant con los prefijos del workspace concreto y,
 *     opcionalmente, la lista exacta de URLs. El render verifica la firma y el
 *     vencimiento. Esto es lo que hace el aislamiento por workspace
 *     (`NFR-006`): sin grant no hay forma de distinguir el workspace 42 del 43.
 *
 * Se aplican LAS DOS cuando las dos están presentes (intersección, no unión).
 * Sin configuración y sin grant no se acepta ninguna URL: el modo por defecto
 * de un servicio mal configurado es rechazar todo, no aceptar todo.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { RenderError } from "../errors.js";
import type { MediaReference } from "../domain/payload.js";

/** Prefijo permitido: origen + comienzo de ruta. `https://cdn.x/media/ws-42/` */
export interface AllowedPrefix {
  readonly origin: string;
  readonly pathPrefix: string;
  readonly protocol: string;
}

export function parsePrefix(raw: string): AllowedPrefix {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RenderError("bad_request", "prefijo de media inválido", {
      details: { prefix: raw },
    });
  }
  if (url.username !== "" || url.password !== "") {
    throw new RenderError(
      "bad_request",
      "un prefijo de media no puede llevar credenciales",
    );
  }
  return {
    origin: url.origin,
    pathPrefix: url.pathname === "" ? "/" : url.pathname,
    protocol: url.protocol,
  };
}

export function parsePrefixList(raw: string | undefined): readonly AllowedPrefix[] {
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map(parsePrefix);
}

/**
 * `true` si `url` cae bajo `prefix`. El match de ruta respeta el límite de
 * segmento: `/media/ws-1/` no matchea `/media/ws-10/foo.mp4`.
 */
export function matchesPrefix(url: URL, prefix: AllowedPrefix): boolean {
  if (url.origin !== prefix.origin) return false;
  if (url.protocol !== prefix.protocol) return false;
  const path = url.pathname;
  const base = prefix.pathPrefix;
  if (base === "/") return true;
  if (!path.startsWith(base)) return false;
  if (path.length === base.length) return true;
  return base.endsWith("/") || path.charAt(base.length) === "/";
}

// ── Grant firmado ────────────────────────────────────────────────────────────

export const mediaGrantBodySchema = z
  .object({
    companyId: z.string().min(1),
    /** Epoch en milisegundos. */
    issuedAt: z.number().int().nonnegative(),
    expiresAt: z.number().int().nonnegative(),
    /** Prefijos del Media Bank del workspace. */
    mediaPrefixes: z.array(z.string().url()).default([]),
    /** Prefijos de la librería compartida. Único origen válido para audio. */
    sharedPrefixes: z.array(z.string().url()).default([]),
    /** Si viene, la URL además tiene que estar textualmente en esta lista. */
    urls: z.array(z.string().url()).optional(),
  })
  .strict();

export type MediaGrantBody = z.infer<typeof mediaGrantBodySchema>;

export const mediaGrantSchema = z
  .object({
    body: mediaGrantBodySchema,
    /** HMAC-SHA256 hex sobre `canonicalGrantBody(body)`. */
    signature: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type MediaGrant = z.infer<typeof mediaGrantSchema>;

/**
 * Serialización canónica del grant: claves ordenadas y arrays ordenados, para
 * que la firma no dependa del orden en que el emisor armó el JSON.
 */
export function canonicalGrantBody(body: MediaGrantBody): string {
  const sorted = (xs: readonly string[]): string[] => [...xs].sort();
  const parts: [string, unknown][] = [
    ["companyId", body.companyId],
    ["expiresAt", body.expiresAt],
    ["issuedAt", body.issuedAt],
    ["mediaPrefixes", sorted(body.mediaPrefixes)],
    ["sharedPrefixes", sorted(body.sharedPrefixes)],
  ];
  if (body.urls !== undefined) parts.push(["urls", sorted(body.urls)]);
  return JSON.stringify(Object.fromEntries(parts));
}

export function signGrantBody(body: MediaGrantBody, secret: string): string {
  return createHmac("sha256", secret).update(canonicalGrantBody(body)).digest("hex");
}

function constantTimeEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface MediaPolicyConfig {
  /** Prefijos aceptados para imagen y video. */
  readonly mediaPrefixes: readonly AllowedPrefix[];
  /** Prefijos de la librería compartida; único origen válido para audio. */
  readonly sharedPrefixes: readonly AllowedPrefix[];
  /** Secreto HMAC del grant. `null` = este despliegue no acepta grants. */
  readonly grantSecret: string | null;
  /** Si `true`, un payload sin grant se rechaza aunque haya configuración. */
  readonly requireGrant: boolean;
  /** Inyectable para test. */
  readonly now: () => number;
}

export interface VerifiedGrant {
  readonly companyId: string;
  readonly mediaPrefixes: readonly AllowedPrefix[];
  readonly sharedPrefixes: readonly AllowedPrefix[];
  readonly urls: ReadonlySet<string> | null;
}

export function verifyGrant(grant: MediaGrant, config: MediaPolicyConfig): VerifiedGrant {
  if (config.grantSecret === null) {
    throw new RenderError(
      "media_grant_invalid",
      "este despliegue no acepta grants firmados",
    );
  }
  const expected = signGrantBody(grant.body, config.grantSecret);
  if (!constantTimeEquals(expected, grant.signature)) {
    // Nunca se dice cuál era la firma esperada.
    throw new RenderError(
      "media_grant_invalid",
      "la firma del grant de media no verifica",
    );
  }
  const now = config.now();
  if (grant.body.expiresAt <= now) {
    throw new RenderError("media_grant_invalid", "el grant de media está vencido", {
      details: { expiredForMs: now - grant.body.expiresAt },
    });
  }
  return {
    companyId: grant.body.companyId,
    mediaPrefixes: grant.body.mediaPrefixes.map(parsePrefix),
    sharedPrefixes: grant.body.sharedPrefixes.map(parsePrefix),
    urls: grant.body.urls === undefined ? null : new Set(grant.body.urls),
  };
}

function reject(reference: MediaReference, reason: string): never {
  throw new RenderError(
    "media_url_not_allowed",
    "la URL de media no pertenece al workspace ni a la librería compartida",
    { details: { path: reference.path.join("."), role: reference.role, reason } },
  );
}

/**
 * Valida una referencia. Se corre ANTES de tocar ffmpeg, sharp o la red.
 */
export function assertMediaReferenceAllowed(
  reference: MediaReference,
  config: MediaPolicyConfig,
  grant: VerifiedGrant | null,
): void {
  let url: URL;
  try {
    url = new URL(reference.url);
  } catch {
    reject(reference, "url_invalida");
  }

  if (url.username !== "" || url.password !== "")
    reject(reference, "credenciales_en_url");

  // Denegación por defecto: sin ninguna fuente de autoridad no entra nada.
  const configuredMedia = config.mediaPrefixes;
  const configuredShared = config.sharedPrefixes;
  const hasConfig = configuredMedia.length > 0 || configuredShared.length > 0;
  if (!hasConfig && grant === null) reject(reference, "sin_politica_configurada");

  if (config.requireGrant && grant === null) reject(reference, "grant_requerido");

  // El audio sólo puede venir de la librería compartida (`FR-070`, explícito).
  const configuredAllowed =
    reference.role === "audio"
      ? configuredShared
      : [...configuredMedia, ...configuredShared];
  const grantAllowed =
    grant === null
      ? null
      : reference.role === "audio"
        ? grant.sharedPrefixes
        : [...grant.mediaPrefixes, ...grant.sharedPrefixes];

  if (hasConfig && !configuredAllowed.some((prefix) => matchesPrefix(url, prefix))) {
    reject(
      reference,
      reference.role === "audio" ? "audio_fuera_de_libreria" : "fuera_de_config",
    );
  }

  if (grantAllowed !== null) {
    if (!grantAllowed.some((prefix) => matchesPrefix(url, prefix))) {
      reject(
        reference,
        reference.role === "audio" ? "audio_fuera_de_libreria" : "fuera_del_grant",
      );
    }
    if (grant !== null && grant.urls !== null && !grant.urls.has(reference.url)) {
      reject(reference, "url_no_listada_en_grant");
    }
  }
}

export function assertAllMediaAllowed(
  references: readonly MediaReference[],
  config: MediaPolicyConfig,
  grant: VerifiedGrant | null,
): void {
  for (const reference of references) {
    assertMediaReferenceAllowed(reference, config, grant);
  }
}
