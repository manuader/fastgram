/**
 * Qué pantalla dibuja `/blitz` · FR-050 *States* (PRD:1150-1160), `P2-BLITZ-013`.
 *
 * Puro y aparte del componente porque es donde vive el error caro: un fallo que
 * se dibuja como cola vacía. `No content yet` después de un 500 le dice al
 * usuario "esperá" cuando lo que corresponde es "algo se rompió".
 */
import { isApiRequestError } from "../../api/errors";
import type { DeckSuggestion } from "./suggestion";

export type DeckView =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "profile" }
  | { readonly kind: "empty"; readonly mode: DeckMode }
  | {
      readonly kind: "deck";
      readonly mode: "preview";
      readonly items: readonly DeckSuggestion[];
    }
  | { readonly kind: "deck"; readonly mode: "blind" };

/** Ver `DeckCard` en `suggestion.ts`. */
export type DeckMode = "preview" | "blind";

/**
 * ¿Este fallo de `GET /blitz/queue` significa "el endpoint no existe"?
 *
 * Un listado nunca contesta 404 por estar vacío: contesta `[]`. Así que un
 * `404 not_found` en esa ruta es el `setNotFoundHandler` de la API —ruta no
 * registrada—, y la pantalla cae al modo `blind` en vez de a un error: aceptar
 * sigue funcionando con `POST /blitz`, que sí existe.
 */
export function isMissingQueueEndpoint(error: unknown): boolean {
  return isApiRequestError(error) && error.status === 404 && error.code === "not_found";
}

/** `409 company_profile_not_ready` (ERR-P08, FR-050 `blocked: profile`). */
export function isProfileNotReady(error: unknown): boolean {
  return isApiRequestError(error) && error.code === "company_profile_not_ready";
}

/** `404 not_found` de `POST /blitz`: la cola está vacía (ERR-E11). */
export function isEmptyQueue(error: unknown): boolean {
  return isApiRequestError(error) && error.status === 404 && error.code === "not_found";
}

/** `422 content_unavailable_for_type`: la API descartó la sugerencia sin cobrar. */
export function isUnbuildable(error: unknown): boolean {
  return isApiRequestError(error) && error.code === "content_unavailable_for_type";
}

export interface DeckViewInput {
  readonly queueStatus: "pending" | "error" | "success";
  readonly queueError: unknown;
  readonly pending: readonly DeckSuggestion[];
  /** Modo blind: la última aceptación contestó cola vacía. */
  readonly blindEmpty: boolean;
  /** Algún `POST /blitz` contestó `409 company_profile_not_ready`. */
  readonly profileBlocked: boolean;
}

export function deckViewFor(input: DeckViewInput): DeckView {
  if (input.profileBlocked) return { kind: "profile" };
  if (input.queueStatus === "pending") return { kind: "loading" };
  if (input.queueStatus === "error") {
    if (isProfileNotReady(input.queueError)) return { kind: "profile" };
    if (isMissingQueueEndpoint(input.queueError)) {
      return input.blindEmpty
        ? { kind: "empty", mode: "blind" }
        : { kind: "deck", mode: "blind" };
    }
    return { kind: "error", error: input.queueError };
  }
  if (input.pending.length === 0) return { kind: "empty", mode: "preview" };
  return { kind: "deck", mode: "preview", items: input.pending };
}
