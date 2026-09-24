/**
 * Credenciales de las apps de desarrollador y redirect URIs — `PU-PUB-002`.
 *
 * Lógica pura, como `packages/core/src/models/config.ts`. El archivo lo
 * lee/escribe `packages/adapters/src/integrations`; la API lo expone.
 *
 * ## Reglas que no se ven en los tipos
 *
 * 1. **El secret nunca sale.** {@link toPublicIntegrationApp} es el único
 *    camino hacia afuera: `hasSecret` y los últimos cuatro, y ni eso si el
 *    secret es tan corto que cuatro caracteres serían buena parte.
 * 2. **Un secret guardado no se hereda a otro client id.** Cambiar el client
 *    id sin traer secret nuevo descarta el guardado: el secret de una app no
 *    sirve para otra, y mandarlo sería filtrarlo a un tercero.
 * 3. **La redirect URI se deriva, no se escribe.** Es
 *    `{FASTGRAM_PUBLIC_URL | http://localhost:3000}/api/fastgram/oauth/{platform}/callback`;
 *    la pantalla la muestra para copiarla a la consola, y la misma función la
 *    usan la autorización y el intercambio del `code` (tienen que coincidir
 *    byte a byte en todas las plataformas).
 */
import {
  OAUTH_PLATFORMS,
  type IntegrationAppConfig,
  type IntegrationsSnapshot,
  type OAuthPlatform,
} from "@fastgram/ports";

import {
  OAUTH_PLATFORM_SPECS,
  requestedScopesOf,
  type OAuthPlatformSpec,
} from "./platforms.js";

/** El origen de la web en uso local (`apps/web`, `next dev -p 3000`). */
export const LOCAL_WEB_ORIGIN = "http://localhost:3000";
export const PUBLIC_URL_ENV = "FASTGRAM_PUBLIC_URL";

const MAX_CLIENT_ID_LENGTH = 256;
const MAX_SECRET_LENGTH = 1024;
const MIN_SECRET_LENGTH_TO_SHOW_LAST4 = 12;

export function oauthCallbackPath(platform: OAuthPlatform): string {
  return `/api/fastgram/oauth/${platform}/callback`;
}

export interface RedirectBase {
  /** Origen sin `/` final. */
  readonly origin: string;
  readonly source: "public_url" | "local";
  /** `FASTGRAM_PUBLIC_URL` estaba puesta pero no es una URL usable. */
  readonly publicUrlInvalid: boolean;
}

/**
 * La base de las redirect URIs: `FASTGRAM_PUBLIC_URL` (el túnel https de
 * Cloudflare, `D-17`) si está y es un origen http(s) válido; si no, la web
 * local. Una URL con path, query o credenciales se rechaza: la redirect URI
 * tiene que ser exactamente la cargada en la consola.
 */
export function resolveRedirectBase(
  env: Readonly<Record<string, string | undefined>>,
): RedirectBase {
  const raw = env[PUBLIC_URL_ENV]?.trim();
  if (raw === undefined || raw === "") {
    return { origin: LOCAL_WEB_ORIGIN, source: "local", publicUrlInvalid: false };
  }
  try {
    const url = new URL(raw);
    const okProtocol = url.protocol === "https:" || url.protocol === "http:";
    const bare =
      (url.pathname === "/" || url.pathname === "") &&
      url.search === "" &&
      url.hash === "" &&
      url.username === "" &&
      url.password === "";
    if (okProtocol && bare) {
      return { origin: url.origin, source: "public_url", publicUrlInvalid: false };
    }
  } catch {
    // cae abajo
  }
  return { origin: LOCAL_WEB_ORIGIN, source: "local", publicUrlInvalid: true };
}

export function redirectUriFor(platform: OAuthPlatform, base: RedirectBase): string {
  return `${base.origin}${oauthCallbackPath(platform)}`;
}

/** `false` sólo si la plataforma **documenta** que exige https y la base no lo es. */
export function redirectAllowed(spec: OAuthPlatformSpec, base: RedirectBase): boolean {
  return spec.https !== "verified" || base.origin.startsWith("https://");
}

/* ------------------------------------------------------------------------ *
 * Vista pública
 * ------------------------------------------------------------------------ */

export interface PublicIntegrationApp {
  readonly platform: OAuthPlatform;
  readonly label: string;
  readonly configured: boolean;
  readonly clientId: string | null;
  readonly hasSecret: boolean;
  readonly secretLast4: string | null;
  readonly updatedAt: string | null;
  readonly redirectUri: string;
  readonly https: OAuthPlatformSpec["https"];
  /** La redirect URI actual cumple lo que la plataforma documenta. */
  readonly redirectAllowed: boolean;
  /** Lo que se pide hoy: los de la plataforma más los opcionales si están habilitados. */
  readonly scopes: readonly string[];
  /** Los scopes opcionales de la plataforma (vacío si no tiene). */
  readonly optionalScopes: readonly string[];
  readonly optionalScopesNote: string | null;
  readonly optionalScopesEnabled: boolean;
  readonly consoleUrl: string;
  readonly docsUrl: string;
  readonly setupNote: string;
}

export function secretLast4(secret: string | undefined): string | null {
  if (secret === undefined || secret.length < MIN_SECRET_LENGTH_TO_SHOW_LAST4)
    return null;
  return secret.slice(-4);
}

export function isIntegrationConfigured(
  config: IntegrationAppConfig | undefined,
): boolean {
  return (
    config !== undefined &&
    config.clientId.length > 0 &&
    config.clientSecret !== undefined &&
    config.clientSecret.length > 0
  );
}

export function toPublicIntegrationApp(
  platform: OAuthPlatform,
  config: IntegrationAppConfig | undefined,
  base: RedirectBase,
): PublicIntegrationApp {
  const spec = OAUTH_PLATFORM_SPECS[platform];
  const secret = config?.clientSecret;
  return {
    platform,
    label: spec.label,
    configured: isIntegrationConfigured(config),
    clientId: config?.clientId ?? null,
    hasSecret: secret !== undefined && secret.length > 0,
    secretLast4: secretLast4(secret),
    updatedAt: config?.updatedAt ?? null,
    redirectUri: redirectUriFor(platform, base),
    https: spec.https,
    redirectAllowed: redirectAllowed(spec, base),
    scopes: requestedScopesOf(platform, config),
    optionalScopes: spec.optionalScopes,
    optionalScopesNote: spec.optionalScopesNote,
    optionalScopesEnabled:
      spec.optionalScopes.length > 0 && config?.optionalScopes === true,
    consoleUrl: spec.consoleUrl,
    docsUrl: spec.docsUrl,
    setupNote: spec.setupNote,
  };
}

export function toPublicIntegrations(
  snapshot: IntegrationsSnapshot,
  base: RedirectBase,
): PublicIntegrationApp[] {
  return OAUTH_PLATFORMS.map((p) => toPublicIntegrationApp(p, snapshot.apps[p], base));
}

/* ------------------------------------------------------------------------ *
 * Escritura
 * ------------------------------------------------------------------------ */

export interface IntegrationUpdateInput {
  readonly clientId: string;
  /** Vacío o ausente = conservar el guardado (si el client id no cambió). */
  readonly clientSecret?: string | undefined;
  /**
   * Pedir los scopes opcionales (`OAuthPlatformSpec.optionalScopes`).
   * Ausente = conservar lo guardado si la app es la misma; con otra app, no.
   */
  readonly optionalScopes?: boolean | undefined;
}

export type IntegrationUpdateResult =
  | { readonly ok: true; readonly config: IntegrationAppConfig }
  | {
      readonly ok: false;
      readonly field: "clientId" | "clientSecret";
      readonly message: string;
    };

/** Sin espacios ni caracteres de control: un id/secret pegado con un salto de línea. */
const TOKENISH = /^[\x21-\x7e]+$/;

export function applyIntegrationUpdate(
  current: IntegrationAppConfig | undefined,
  input: IntegrationUpdateInput,
  nowIso: string,
): IntegrationUpdateResult {
  const clientId = input.clientId.trim();
  if (clientId.length === 0) {
    return { ok: false, field: "clientId", message: "Client ID is required." };
  }
  if (clientId.length > MAX_CLIENT_ID_LENGTH || !TOKENISH.test(clientId)) {
    return {
      ok: false,
      field: "clientId",
      message: "That Client ID does not look right.",
    };
  }
  const typed = input.clientSecret?.trim() ?? "";
  if (typed.length > MAX_SECRET_LENGTH || (typed.length > 0 && !TOKENISH.test(typed))) {
    return {
      ok: false,
      field: "clientSecret",
      message: "That Client secret does not look right.",
    };
  }
  // Regla 2: el secret guardado sólo sobrevive si la app es la misma.
  const kept =
    typed.length === 0 && current !== undefined && current.clientId === clientId
      ? current.clientSecret
      : undefined;
  const secret = typed.length > 0 ? typed : kept;
  const optionalScopes =
    input.optionalScopes ??
    (current !== undefined && current.clientId === clientId
      ? current.optionalScopes
      : undefined);
  return {
    ok: true,
    config: {
      clientId,
      ...(secret === undefined ? {} : { clientSecret: secret }),
      ...(optionalScopes === true ? { optionalScopes: true } : {}),
      updatedAt: nowIso,
    },
  };
}
