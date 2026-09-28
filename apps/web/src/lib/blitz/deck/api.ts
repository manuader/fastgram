"use client";

/**
 * El deck contra la API · `PU-BLITZ-001/002`.
 *
 * | Operación | Ruta                                  |
 * |-----------|---------------------------------------|
 * | ver cola  | `GET /blitz/queue`                    |
 * | descartar | `POST /blitz/queue/:id/discard`       |
 * | aceptar   | `POST /blitz` con `suggestionId`      |
 *
 * Las tres existen (`PU-BLITZ-002`). Un fallo de la cola —404 incluido— es un
 * error de pantalla (ver `state.ts`).
 *
 * ## `POST /blitz` no se reintenta nunca solo
 *
 * FR-050 / NFR-005: *"la operación no es idempotente: nunca reintentar
 * automáticamente"*. `mutations.retry` ya es `false` en el `QueryClient`; lo que
 * agrega este módulo es la `Idempotency-Key`, que la ruta acepta opcional
 * (aclaración del 2026-09-21): la genera **quien abre el intento** y la reusa si
 * el usuario reintenta ese mismo intento a mano. Así un doble click o un
 * reintento tras un timeout no cobran dos veces.
 */
import { contentSchema, type Content } from "@fastgram/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiRequest, apiSend } from "../../api/client";
import { isApiRequestError, type ApiRequestError } from "../../api/errors";
import { queryKeys } from "../../api/keys";
import {
  deckQueueSchema,
  needsRefill,
  QUEUE_POLL_MS,
  type DeckSuggestion,
} from "./suggestion";

/** Clave de caché de la cola. Cuelga de `blitz`, como `blitzPreferences`. */
export const blitzQueueKey = () => ["blitz", "queue"] as const;

export const BLITZ_QUEUE_PATH = "/blitz/queue";
export const BLITZ_ACCEPT_PATH = "/blitz";
export const blitzDiscardPath = (suggestionId: string): string =>
  `/blitz/queue/${encodeURIComponent(suggestionId)}/discard`;

/**
 * La cadencia de la cola: se pregunta mientras esté corta (relleno en
 * background, F-050) y se deja de preguntar cuando hay de sobra.
 *
 * Con un error se sigue preguntando sólo si puede cambiar solo (5xx, red): un
 * 4xx —la marca no es del dueño, el perfil no está listo— no se arregla
 * esperando, y la pantalla ofrece el reintento a mano.
 */
export function queuePollInterval(
  data: readonly DeckSuggestion[] | undefined,
  error: unknown,
): number | false {
  if (error !== null && error !== undefined) {
    return isTransient(error) ? QUEUE_POLL_MS : false;
  }
  if (data === undefined) return false;
  return needsRefill(data.length) ? QUEUE_POLL_MS : false;
}

/** Un fallo que puede irse solo: 5xx o sin respuesta (`status` 0). */
function isTransient(error: unknown): boolean {
  return !isApiRequestError(error) || error.status === 0 || error.status >= 500;
}

/** `GET /blitz/queue`. Ver la cabecera. */
export function useBlitzQueue(): UseQueryResult<
  readonly DeckSuggestion[],
  ApiRequestError
> {
  return useQuery<readonly DeckSuggestion[], ApiRequestError>({
    queryKey: blitzQueueKey(),
    queryFn: ({ signal }) =>
      apiRequest<readonly DeckSuggestion[]>(BLITZ_QUEUE_PATH, {
        signal,
        schema: deckQueueSchema,
      }),
    // La cola la mueve el refill en background: nada de ventana de frescura.
    staleTime: 0,
    retry: (failureCount, error) => error.status >= 500 && failureCount < 2,
    refetchInterval: (query) => queuePollInterval(query.state.data, query.state.error),
  });
}

export interface AcceptVariables {
  /** La tarjeta que el usuario vio. */
  readonly suggestionId: string;
  /** Una por intento: el reintento manual del mismo intento la reusa. */
  readonly idempotencyKey: string;
  /**
   * Sprint 9 (T): `edit` = «Edit» del deck (acepta y abre el editor). La API
   * guarda la señal de preferencias como `edit_before_accept`.
   */
  readonly via?: "edit" | undefined;
}

/**
 * `POST /blitz` → `202 { data: Content }` en `BUILDING`.
 *
 * `suggestionId` viaja siempre: sin él, aceptar "la tarjeta de arriba" es
 * aceptar **la primera de la cola en ese momento**, y un refill que entre entre
 * el render y el swipe cambiaría cuál es.
 *
 * Al volver: la pieza se siembra en la caché de `GET /content/:id` —así el
 * tracker la dibuja al instante y el polling de ADR-014 arranca solo— y
 * se invalidan los listados de la Library, que tienen una pieza nueva.
 */
export function useAcceptSuggestion(): UseMutationResult<
  Content,
  ApiRequestError,
  AcceptVariables
> {
  const queryClient = useQueryClient();
  return useMutation<Content, ApiRequestError, AcceptVariables>({
    mutationFn: ({ suggestionId, idempotencyKey, via }) =>
      apiRequest<Content>(BLITZ_ACCEPT_PATH, {
        method: "POST",
        body: via === undefined ? { suggestionId } : { suggestionId, via },
        idempotencyKey,
        schema: contentSchema,
      }),
    onSuccess: (content) => {
      queryClient.setQueryData(queryKeys.contentItem(content._id), content);
      void queryClient.invalidateQueries({ queryKey: ["content"] });
    },
  });
}

/** `POST /blitz/queue/:id/discard`. Rechazar no consume cuota (FR-050). */
export function useDiscardSuggestion(): UseMutationResult<void, ApiRequestError, string> {
  return useMutation<void, ApiRequestError, string>({
    mutationFn: (suggestionId) =>
      apiSend(blitzDiscardPath(suggestionId), { method: "POST" }),
  });
}
