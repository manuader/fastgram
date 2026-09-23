/**
 * Alta del primer workspace — `P1-TENANT-001`, `F-008`, PRD §15.4, `DATA-002`,
 * y la decisión del dueño del producto de PRD §2.4 (2026-09-23).
 *
 * ## Interno, como `/auth/*`
 *
 * §9.3 no enumera ninguna ruta de workspaces y §15.4 sólo dice que el primero
 * *"nace durante el onboarding"*. El único cliente es el BFF de `apps/web`, con
 * la sesión del usuario en `X-Fastgram-Session`: **una API key no puede crear
 * workspaces** (la key ya es de uno). En el OpenAPI va `x-internal` y
 * `security: []`.
 *
 *   POST /onboarding/workspace   → 201 {data: Workspace}
 *
 * Es la **única** ruta de `/api/v1` que acepta una sesión sin workspace: es la
 * que lo crea. Las demás siguen respondiendo 403 a esa sesión.
 *
 * ## Por qué el request casi no valida
 *
 * Por lo mismo que el cuestionario (`onboarding.ts`): la copy de `FR-010`
 * (*"Company name is required"*, *"Please enter a valid website URL"*,
 * *"Localhost URLs are not allowed"*) vive en `packages/core`, y un `.min(2)`
 * acá haría que Fastify rechazara antes con un 400 genérico. Lo único que este
 * schema fija son **cotas de sanidad**, no números del PRD.
 *
 * ## Por qué no lleva `Idempotency-Key`
 *
 * El registro de idempotencia (`DATA-027`) tiene PK `(companyId, key)` y RLS
 * por workspace: antes de que el workspace exista no hay dónde guardar la key.
 * Y no hace falta: la operación **ya es idempotente por usuario** —un usuario
 * sin workspace crea uno; con workspace, 409—, y el reintento de un alta que
 * sí se hizo recibe 409 `workspace_already_exists` y lee su `companyId` de
 * `GET /auth/session`.
 */
import { z } from "zod";

/** Cota de sanidad para `Company Name`. **No** es un número del PRD. */
export const WORKSPACE_NAME_MAX_CHARS = 200;
/** Cota de sanidad para una URL. **No** es un número del PRD. */
export const WORKSPACE_WEBSITE_MAX_CHARS = 2048;

/**
 * `reason` de los 409 de esta ruta, en `error.details.reason`. Es lo que la web
 * lee para decidir qué hacer: el `message` es copy y puede cambiar.
 */
export const CREATE_WORKSPACE_CONFLICT_REASONS = [
  /** Ya es miembro activo de un workspace: ir a `GET /auth/session`. */
  "workspace_already_exists",
  /** `DATA-002`: *"This website is already registered."* (`FR-010`). */
  "website_already_registered",
] as const;
export type CreateWorkspaceConflictReason =
  (typeof CREATE_WORKSPACE_CONFLICT_REASONS)[number];

/** Estados de `DATA-002`. */
export const WORKSPACE_STATUSES = [
  "draft",
  "preparing",
  "active",
  "soft_deleted",
] as const;
/** `DATA-002` — `subscriptionStatus`. */
export const WORKSPACE_SUBSCRIPTION_STATUSES = [
  "trialing",
  "active",
  "past_due",
  "canceled",
] as const;

// --- Request -----------------------------------------------------------------

/**
 * `POST /onboarding/workspace`.
 *
 * - `name` — `Company Name` de `FR-010`. Obligatorio; el mínimo de 2 lo
 *   aplica el dominio con su copy.
 * - `websiteUrl` — opcional por `EXT-001`. `null`, ausente o `""` = sin web.
 *   Si viene, tiene que ser una **web** (no un perfil social: ése va por
 *   `POST /brand/sources`), y es única global.
 */
export const createWorkspaceRequestSchema = z
  .object({
    name: z.string().max(WORKSPACE_NAME_MAX_CHARS),
    websiteUrl: z.string().max(WORKSPACE_WEBSITE_MAX_CHARS).nullable().optional(),
  })
  .strict();
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

// --- Response ----------------------------------------------------------------

/**
 * El workspace recién creado. Proyección de `DATA-002`: lo que la web necesita
 * para seguir el wizard, no la fila entera (`ownerUserId`, `entitlements`,
 * `billingAnchorDay` y `partnerId` no salen).
 */
export const workspaceSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    websiteUrl: z.string().nullable(),
    status: z.enum(WORKSPACE_STATUSES),
    planId: z.string().min(1),
    subscriptionStatus: z.enum(WORKSPACE_SUBSCRIPTION_STATUSES),
    timezone: z.string().min(1),
    createdAt: z.string().datetime(),
  })
  .strict();
export type Workspace = z.infer<typeof workspaceSchema>;
