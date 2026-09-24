/**
 * Connections · `GET /connections` (PRD:2273).
 *
 * Fuente: DATA-016 (PRD:2111), NFR-007 (PRD:2957).
 *
 * `accessToken` y `refreshToken` están cifrados y **nunca se exponen**
 * (DATA-016, PRD:2111): no aparecen en este schema, que es el contrato público.
 */
import { z } from "zod";
import { connectionStatusSchema, platformSchema } from "../primitives/enums.js";
import { connectionIdSchema, msEpochSchema } from "../primitives/ids.js";

export const connectionSchema = z
  .object({
    _id: connectionIdSchema,
    platform: platformSchema,
    platformUserId: z.string().min(1),
    platformUsername: z.string().min(1),
    scopes: z.array(z.string()),
    publishable: z.boolean(),
    tokenExpiry: msEpochSchema,
    status: connectionStatusSchema,
    createdAt: msEpochSchema,
    updatedAt: msEpochSchema,
  })
  .strict();
export type Connection = z.infer<typeof connectionSchema>;

// ---------------------------------------------------------------------------
// OAuth por marca y credenciales de las apps · `PU-PUB-001`, `PU-PUB-002`,
// `P3-OAUTH-002`, `P3-OAUTH-008` (`docs/PLAN-USO-PERSONAL.md` §5, §9).
//
// Fuera de la §9.3 del PRD (uso personal). Dos reglas que valen para todo lo
// de abajo:
//
// 1. **Ningún schema de respuesta tiene un campo para un token o un secret.**
//    Las credenciales de la app salen como `hasSecret` + últimos cuatro; los
//    tokens de una conexión no salen de ninguna forma (`NFR-007`).
// 2. Los errores viajan con los códigos existentes (`bad_request`,
//    `conflict`, `not_found`, `service_unavailable`) y el motivo estable en
//    `details.reason` ({@link connectionErrorReasonSchema}): el enum de
//    `errorCodeSchema` es del PRD y no se amplía por esto.
// ---------------------------------------------------------------------------

/** Las redes con OAuth en uso personal (`D-09`, en orden; YouTube y LinkedIn al final). */
export const oauthPlatformSchema = z.enum([
  "instagram",
  "tiktok",
  "x",
  "threads",
  "facebook",
  "youtube",
  "linkedin",
]);
export type OAuthPlatformId = z.infer<typeof oauthPlatformSchema>;

/** `details.reason` de los errores de este recurso. */
export const connectionErrorReasonSchema = z.enum([
  /** Faltan client id / secret de la app (Settings → Integrations). */
  "integration_not_configured",
  /** La plataforma exige https y `FASTGRAM_PUBLIC_URL` no está puesta. */
  "https_redirect_required",
  /** `state` ausente, alterado, vencido o ya usado. */
  "oauth_state_invalid",
  /** El `state` es de otra marca: se cambió la marca activa en medio del login. */
  "oauth_state_wrong_brand",
  /** El usuario no aprobó los permisos (ERR-D04). */
  "oauth_denied",
  /** La plataforma rechazó el intercambio del `code` o respondió algo inesperado. */
  "oauth_exchange_failed",
  /** La plataforma no respondió. Reintentable. */
  "oauth_provider_unavailable",
  /** Facebook: la cuenta no administra ninguna Página (YouTube: la cuenta no tiene canal). */
  "no_pages",
  /** Facebook / LinkedIn: la elección de Página venció o ya se usó. */
  "selection_expired",
  /** La plataforma rechazó el refresco: hay que reconectar (ERR-D01). */
  "connection_expired",
  /** `paused`/`revoked`: hay que reconectar. */
  "connection_inactive",
]);
export type ConnectionErrorReason = z.infer<typeof connectionErrorReasonSchema>;

/** Una app de desarrollador, sin el secret. */
export const integrationAppSchema = z
  .object({
    platform: oauthPlatformSchema,
    label: z.string(),
    configured: z.boolean(),
    clientId: z.string().nullable(),
    hasSecret: z.boolean(),
    secretLast4: z.string().nullable(),
    updatedAt: z.string().nullable(),
    /** La que hay que cargar, tal cual, en la consola de la plataforma. */
    redirectUri: z.string(),
    /** `verified`: la plataforma documenta que exige https. */
    https: z.enum(["verified", "recommended", "no"]),
    /** `false` si la plataforma exige https y la redirect URI no lo es. */
    redirectAllowed: z.boolean(),
    /** Lo que se pide hoy (incluye los opcionales si están habilitados). */
    scopes: z.array(z.string()),
    /** Scopes que se piden sólo si se habilitan (hoy: Páginas de LinkedIn). */
    optionalScopes: z.array(z.string()),
    /** Qué habilitan los opcionales. `null` si la plataforma no tiene. */
    optionalScopesNote: z.string().nullable(),
    optionalScopesEnabled: z.boolean(),
    consoleUrl: z.string(),
    docsUrl: z.string(),
    setupNote: z.string(),
  })
  .strict();
export type IntegrationApp = z.infer<typeof integrationAppSchema>;

export const integrationsOverviewSchema = z
  .object({
    apps: z.array(integrationAppSchema),
    redirectBase: z.string(),
    /** `public_url` = `FASTGRAM_PUBLIC_URL` (el túnel); `local` = localhost. */
    redirectSource: z.enum(["public_url", "local"]),
    publicUrlInvalid: z.boolean(),
  })
  .strict();
export type IntegrationsOverview = z.infer<typeof integrationsOverviewSchema>;

/** `PUT /integrations/{platform}`. Secret vacío o ausente = conservar el guardado. */
export const updateIntegrationRequestSchema = z
  .object({
    clientId: z.string().max(256),
    clientSecret: z.string().max(1024).optional(),
    /** Pedir los scopes opcionales. Ausente = conservar lo guardado. */
    optionalScopes: z.boolean().optional(),
  })
  .strict();
export type UpdateIntegrationRequest = z.infer<typeof updateIntegrationRequestSchema>;

/** Una cuenta conectada, como la ve la pantalla. Sin tokens. */
export const connectionAccountSchema = z
  .object({
    _id: connectionIdSchema,
    platform: platformSchema,
    platformUserId: z.string(),
    username: z.string(),
    displayName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
    status: connectionStatusSchema,
    /** Código estable de por qué no está `active` (`refresh_rejected`, `disconnected`…). */
    statusReason: z.string().nullable(),
    scopes: z.array(z.string()),
    /** Concedió todos los permisos pedidos. `false` = ERR-D03 (`Permissions Missing`). */
    publishable: z.boolean(),
    /** ms epoch; `null` = no vence (Página de Facebook). */
    tokenExpiresAt: z.number().int().nullable(),
    createdAt: msEpochSchema,
    updatedAt: msEpochSchema,
  })
  .strict();
export type ConnectionAccount = z.infer<typeof connectionAccountSchema>;

export const authorizeConnectionResponseSchema = z
  .object({
    /** La URL de la plataforma. El navegador va ahí. */
    url: z.string(),
    redirectUri: z.string(),
    /** ms epoch en que vence el `state`. */
    expiresAt: z.number().int(),
  })
  .strict();
export type AuthorizeConnectionResponse = z.infer<
  typeof authorizeConnectionResponseSchema
>;

/**
 * `POST /connections/{platform}/callback`. Lo manda la ruta de callback de
 * `apps/web`, no el navegador: `code` nunca pasa por JavaScript de la página.
 */
export const connectionCallbackRequestSchema = z
  .object({
    state: z.string().max(2048),
    code: z.string().max(4096).optional(),
    error: z.string().max(256).optional(),
    errorDescription: z.string().max(1024).optional(),
  })
  .strict();
export type ConnectionCallbackRequest = z.infer<typeof connectionCallbackRequestSchema>;

export const facebookPageOptionSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    avatarUrl: z.string().nullable(),
  })
  .strict();
export type FacebookPageOption = z.infer<typeof facebookPageOptionSchema>;

export const connectionCallbackResultSchema = z.discriminatedUnion("kind", [
  z
    .object({ kind: z.literal("connected"), connection: connectionAccountSchema })
    .strict(),
  /**
   * Más de una cuenta para elegir: Páginas de Facebook
   * (`POST /connections/facebook/pages`) o perfil y Páginas de LinkedIn
   * (`POST /connections/linkedin/pages`).
   */
  z
    .object({
      kind: z.literal("choose_page"),
      selectionId: z.string(),
      pages: z.array(facebookPageOptionSchema),
      expiresAt: z.number().int(),
    })
    .strict(),
]);
export type ConnectionCallbackResult = z.infer<typeof connectionCallbackResultSchema>;

export const facebookPageSelectionSchema = z
  .object({
    /** De qué red es la elección. Ausente en respuestas viejas = `facebook`. */
    platform: oauthPlatformSchema.optional(),
    selectionId: z.string(),
    pages: z.array(facebookPageOptionSchema),
    expiresAt: z.number().int(),
  })
  .strict();
export type FacebookPageSelection = z.infer<typeof facebookPageSelectionSchema>;

export const selectFacebookPageRequestSchema = z
  .object({ selectionId: z.string().max(128), pageId: z.string().max(128) })
  .strict();
export type SelectFacebookPageRequest = z.infer<typeof selectFacebookPageRequestSchema>;
