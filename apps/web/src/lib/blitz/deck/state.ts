/**
 * Qué pantalla dibuja `/blitz` · FR-050 *States* (PRD:1150-1160), `P2-BLITZ-013`.
 *
 * Puro y aparte del componente porque es donde vive el error caro: un fallo que
 * se dibuja como cola vacía. `No content yet` después de un 500 le dice al
 * usuario "esperá" cuando lo que corresponde es "algo se rompió".
 *
 * Un `404` de `GET /blitz/queue` también es un error: la ruta existe
 * (`PU-BLITZ-002`), así que un 404 es una marca que no es del dueño o que ya no
 * está. Hasta el 2026-09-24 se leía como "endpoint ausente" y la pantalla
 * decía *"Previews aren't available yet"*.
 */
import { isApiRequestError } from "../../api/errors";
import type { DeckSuggestion } from "./suggestion";

export type DeckView =
  | { readonly kind: "loading" }
  | { readonly kind: "error"; readonly error: unknown }
  | { readonly kind: "profile" }
  | { readonly kind: "empty" }
  | { readonly kind: "deck"; readonly items: readonly DeckSuggestion[] };

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
  /** Algún `POST /blitz` contestó `409 company_profile_not_ready`. */
  readonly profileBlocked: boolean;
}

export function deckViewFor(input: DeckViewInput): DeckView {
  if (input.profileBlocked) return { kind: "profile" };
  if (input.queueStatus === "pending") return { kind: "loading" };
  if (input.queueStatus === "error") {
    if (isProfileNotReady(input.queueError)) return { kind: "profile" };
    return { kind: "error", error: input.queueError };
  }
  if (input.pending.length === 0) return { kind: "empty" };
  return { kind: "deck", items: input.pending };
}
