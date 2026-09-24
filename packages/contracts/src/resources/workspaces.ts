/**
 * Marcas (workspaces) en modo personal — `PU-BRAND-001`, `D-06`/`D-07` (PRD §2.7).
 *
 * ## De dónde sale este contrato
 *
 * No es del PRD original: §9.3 no tiene ninguna ruta de workspaces porque la API
 * de Fastlane es por key y la key queda atada a **un** workspace (FR-180). El
 * plan de uso personal (`docs/PLAN-USO-PERSONAL.md` §3) cambia eso: un solo
 * usuario, una marca por workspace, y un selector de marca en el shell. La forma
 * la fijó el coordinador del sprint 1 y se copia acá sin agregar campos.
 *
 *   GET    /workspaces        las marcas del dueño de la key
 *   POST   /workspaces        crea una marca (plan `pro`, perfil `pending`)
 *   PATCH  /workspaces/{id}   la renombra
 *   DELETE /workspaces/{id}   soft delete; la última activa → `409`
 *   GET    /mode              `personal` | `standard`
 *
 * ## La selección de marca va por header, no por ruta
 *
 * {@link WORKSPACE_HEADER} cambia el scope de **toda** la request. Así las ~30
 * rutas existentes quedan multimarca sin tocarlas una por una: el cambio vive
 * donde se resuelve el `companyId` de la key (`apps/api/src/auth/scope.ts`).
 * Fuera del modo personal el header se ignora.
 *
 * `createdAt` va en ISO y no en ms epoch —a diferencia del resto de la v1— porque
 * así lo fijó el contrato del coordinador. Es una desviación consciente.
 */
import { z } from "zod";

/** Header de selección de marca. En minúsculas porque así lo entrega Node. */
export const WORKSPACE_HEADER = "x-fastgram-workspace";

/** Largo máximo del nombre de una marca (contrato del sprint 1). */
export const WORKSPACE_NAME_MAX_CHARS = 80;

/** Espeja `COMPANY_PROFILE_STATUS` de `packages/db` (DATA-004). */
export const workspaceProfileStatusSchema = z.enum([
  "pending",
  "ready",
  "failed",
  "partial",
]);
export type WorkspaceProfileStatus = z.infer<typeof workspaceProfileStatusSchema>;

export const workspaceSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    /** `pending` hasta que la marca se analiza (análisis desde la web, EXT-001). */
    profileStatus: workspaceProfileStatusSchema,
    createdAt: z.string().datetime(),
  })
  .strict();
export type Workspace = z.infer<typeof workspaceSchema>;

/**
 * El nombre se recorta **antes** de medir: `"   "` es un nombre vacío, no uno de
 * tres caracteres.
 */
const workspaceNameSchema = z.string().trim().min(1).max(WORKSPACE_NAME_MAX_CHARS);

export const createWorkspaceRequestSchema = z
  .object({ name: workspaceNameSchema })
  .strict();
export type CreateWorkspaceRequest = z.infer<typeof createWorkspaceRequestSchema>;

export const updateWorkspaceRequestSchema = z
  .object({ name: workspaceNameSchema })
  .strict();
export type UpdateWorkspaceRequest = z.infer<typeof updateWorkspaceRequestSchema>;

export const workspaceListResponseSchema = z.object({ data: z.array(workspaceSchema) });
export type WorkspaceListResponse = z.infer<typeof workspaceListResponseSchema>;

export const workspaceResponseSchema = z.object({ data: workspaceSchema });
export type WorkspaceResponse = z.infer<typeof workspaceResponseSchema>;

// --- Modo ---------------------------------------------------------------------

/**
 * `personal` apaga cuotas, rate limiting y billing (`D-06`) y prende las marcas.
 * `standard` es el comportamiento del PRD original.
 */
export const FASTGRAM_MODES = ["personal", "standard"] as const;
export const fastgramModeSchema = z.enum(FASTGRAM_MODES);
export type FastgramMode = z.infer<typeof fastgramModeSchema>;

export const modeSchema = z.object({ mode: fastgramModeSchema }).strict();
export type ModeInfo = z.infer<typeof modeSchema>;

export const modeResponseSchema = z.object({ data: modeSchema });
export type ModeResponse = z.infer<typeof modeResponseSchema>;
