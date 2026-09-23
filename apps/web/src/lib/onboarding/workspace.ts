"use client";

/**
 * El primer workspace · `P1-TENANT-001` (web), `FR-010`, PRD §15.4.
 *
 * Un usuario recién registrado tiene sesión válida y `companyId: null`. Todas
 * las rutas de negocio le responden `403` —también `GET /onboarding`—, así que
 * el wizard no puede ni leer su estado. La única ruta de `/api/v1` que acepta
 * esa sesión es `POST /onboarding/workspace`, y este módulo es su cliente.
 *
 * ## Por dónde va
 *
 * Por el proxy (`/api/fastgram/v1/onboarding/workspace`) con `apiRequest`, como
 * cualquier otra escritura: el proxy exige el header anti-CSRF (que `apiRequest`
 * pone siempre en no-`GET`) y reenvía la cookie como `X-Fastgram-Session`. No es
 * `/auth/*`, así que la regla 3 del proxy no la bloquea. **Sin
 * `Idempotency-Key`**: la API no la lee (no hay workspace donde guardarla) y la
 * operación ya es idempotente por usuario — el reintento de un alta que sí se
 * hizo recibe el `409 workspace_already_exists` de abajo.
 *
 * ## El 409 que no es un error
 *
 * `workspace_already_exists` quiere decir "ya lo tenés": el doble clic que llegó
 * segundo, el reintento tras un timeout que sí escribió, otra pestaña que se
 * adelantó, o una página renderizada antes del alta. En todos, lo que el
 * usuario quería ya está hecho. Por eso la mutación **no falla** con ese 409:
 * resuelve `{ kind: "existing" }` y la pantalla sigue igual que tras un `201`.
 * Se lee `details.reason`, nunca el `message` (que es copy y cambia).
 *
 * El otro 409, `website_already_registered`, sí es un error — del campo
 * `websiteUrl` (`FR-010` criterio 5).
 */
import {
  workspaceSchema,
  type CreateWorkspaceRequest,
  type Workspace,
} from "@fastgram/contracts";
import { useMutation, type UseMutationResult } from "@tanstack/react-query";
import type { CopyKey } from "../i18n/t";
import { apiRequest } from "../api/client";
import { presentError, type Remedy } from "../api/error-presentation";
import { isApiRequestError, type ApiRequestError } from "../api/errors";

export const WORKSPACE_PATH = "/onboarding/workspace";

/** Los dos campos del paso. Son los nombres del contrato, que es lo que manda `details.field`. */
export type WorkspaceField = "name" | "websiteUrl";

/**
 * El cuerpo a partir de lo escrito.
 *
 * · `name` va **tal cual**: la API lo recorta y mide el recortado (`core`,
 *   `planFirstWorkspace`). Recortarlo acá también sería una segunda copia de la
 *   regla, y la de la API es la que decide.
 * · `websiteUrl` vacío (o sólo espacios) → `null`: es opcional por `EXT-001`, y
 *   el contrato dice que `null`, ausente y `""` significan lo mismo. Se manda
 *   `null` explícito para que el cuerpo diga "sin web" y no dependa de eso.
 */
export function workspaceBodyOf(name: string, website: string): CreateWorkspaceRequest {
  const trimmed = website.trim();
  return { name, websiteUrl: trimmed === "" ? null : trimmed };
}

export type WorkspaceOutcome =
  | { readonly kind: "created"; readonly workspace: Workspace }
  | { readonly kind: "existing" };

export function isWorkspaceAlreadyExists(error: unknown): boolean {
  return (
    isApiRequestError(error) &&
    error.code === "conflict" &&
    error.details?.["reason"] === "workspace_already_exists"
  );
}

/**
 * `POST /onboarding/workspace`.
 *
 * No toca la caché de `GET /onboarding`, y no es un olvido. Antes del alta esa
 * query no se monta (`OnboardingEntry`), así que no hay nada que olvidar; y si
 * hubiera un `403` guardado, TanStack lo descarta solo: una query en error y
 * **sin datos** vuelve a `pending` al montarse el observador y refetchear
 * (`retryOnMount`, default). Se probó: con un `removeQueries` acá y sin él, el
 * test del `403` en caché da lo mismo (reporte de la tarea).
 */
export function useCreateWorkspace(): UseMutationResult<
  WorkspaceOutcome,
  ApiRequestError,
  CreateWorkspaceRequest
> {
  return useMutation<WorkspaceOutcome, ApiRequestError, CreateWorkspaceRequest>({
    mutationFn: async (body) => {
      try {
        const workspace = await apiRequest(WORKSPACE_PATH, {
          method: "POST",
          body,
          schema: workspaceSchema,
        });
        return { kind: "created", workspace };
      } catch (error) {
        if (isWorkspaceAlreadyExists(error)) return { kind: "existing" };
        throw error;
      }
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Presentación de los fallos
// ───────────────────────────────────────────────────────────────────────────

/**
 * Los literales de `FR-010` que la API manda en `message` con `details.field`.
 *
 * Misma regla que `VALIDATION_LITERALS` de `brand-source.ts`: no se pinta el
 * `message` del servidor, se **reconoce** contra esta lista cerrada y se pinta
 * la clave del catálogo propio. Los tres SSRF llegan con `field: "websiteUrl"`
 * porque la API valida la web con el mismo detector que las Brand Sources.
 */
const FIELD_LITERALS: Readonly<Record<string, CopyKey>> = {
  "Company name is required": "onboarding.workspace.nameRequired",
  "Company name must be at least 2 characters": "onboarding.workspace.nameTooShort",
  "Please enter a valid website URL": "onboarding.workspace.websiteInvalid",
  "This website is already registered.": "onboarding.workspace.websiteTaken",
  "Localhost URLs are not allowed": "onboarding.validation.localhost",
  "Private IP addresses are not allowed": "onboarding.validation.privateIp",
  "Blocked URL for security reasons": "onboarding.validation.blocked",
};

/**
 * Si el literal no está en la lista (la API cambió el copy), el campo igual se
 * marca —`details.field` es el dato estable— con un texto genérico **de ese
 * campo**. El genérico de formulario (*"That request wasn't valid"*) al lado
 * del input equivocado sería peor.
 */
const FIELD_FALLBACK: Readonly<Record<WorkspaceField, CopyKey>> = {
  name: "onboarding.workspace.nameRequired",
  websiteUrl: "onboarding.workspace.websiteInvalid",
};

function fieldOf(value: unknown): WorkspaceField | null {
  return value === "name" || value === "websiteUrl" ? value : null;
}

export type WorkspaceProblem =
  /** Va debajo de un campo, enlazado por `aria-describedby`. */
  | { readonly kind: "field"; readonly field: WorkspaceField; readonly titleKey: CopyKey }
  /** Va sobre el botón: no es de ningún campo. */
  | {
      readonly kind: "form";
      readonly titleKey: CopyKey;
      readonly remedy: Remedy;
    };

/**
 * Un fallo del alta, a campo o a formulario.
 *
 * · `400` con `details.field` → ese campo (literal de `FR-010`).
 * · `409 website_already_registered` → `websiteUrl`. Se decide por
 *   `details.reason` y no por el literal: es el dato que el contrato publica
 *   para eso (`CREATE_WORKSPACE_CONFLICT_REASONS`).
 * · Lo demás → formulario, con la salida de `presentError` (un `503` o la red
 *   se reintentan; un `401` no).
 */
export function presentWorkspaceError(error: unknown): WorkspaceProblem {
  if (isApiRequestError(error)) {
    if (
      error.code === "conflict" &&
      error.details?.["reason"] === "website_already_registered"
    ) {
      return {
        kind: "field",
        field: "websiteUrl",
        titleKey: "onboarding.workspace.websiteTaken",
      };
    }
    const field = fieldOf(error.details?.["field"]);
    if (error.code === "bad_request" && field !== null) {
      const known =
        error.serverMessage === undefined
          ? undefined
          : FIELD_LITERALS[error.serverMessage];
      return { kind: "field", field, titleKey: known ?? FIELD_FALLBACK[field] };
    }
  }
  const { titleKey, remedy } = presentError(error);
  return { kind: "form", titleKey, remedy };
}
