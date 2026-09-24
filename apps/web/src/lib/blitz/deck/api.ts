"use client";

/**
 * El deck contra la API · `PU-BLITZ-001/002`.
 *
 * Tres operaciones, y sólo una existe hoy:
 *
 * | Operación | Ruta                                  | Estado             |
 * |-----------|---------------------------------------|--------------------|
 * | ver cola  | `GET /blitz/queue`                    | **no existe**      |
 * | descartar | `POST /blitz/queue/:id/discard`       | **no existe**      |
 * | aceptar   | `POST /blitz`                         | existe (FR-050)    |
 *
 * Las dos que faltan están escritas contra la forma **propuesta** en el handoff
 * de esta tarea. Mientras no existan, `GET /blitz/queue` contesta el 404 de ruta
 * inexistente y la pantalla pasa a modo `blind` (ver `state.ts`): aceptar
 * funciona, descartar no se ofrece. Ningún camino llama a descartar en ese modo.
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
import type { ApiRequestError } from "../../api/errors";
import { queryKeys } from "../../api/keys";
import { isMissingQueueEndpoint } from "./state";
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
 * Con el endpoint inexistente no se pregunta más: el 404 no va a cambiar solo,
 * y martillear una ruta que no existe es rate limit tirado.
 */
export function queuePollInterval(
  data: readonly DeckSuggestion[] | undefined,
  error: unknown,
): number | false {
  if (error !== null && error !== undefined) {
    return isMissingQueueEndpoint(error) ? false : QUEUE_POLL_MS;
  }
  if (data === undefined) return false;
  return needsRefill(data.length) ? QUEUE_POLL_MS : false;
}

/** `GET /blitz/queue` (propuesto). Ver la cabecera. */
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
    // El 404 de ruta inexistente no se reintenta: es una respuesta, no un fallo.
    retry: (failureCount, error) =>
      !isMissingQueueEndpoint(error) && error.status >= 500 && failureCount < 2,
    refetchInterval: (query) => queuePollInterval(query.state.data, query.state.error),
  });
}

export interface AcceptVariables {
  /** La tarjeta que el usuario vio. `undefined` en modo `blind`. */
  readonly suggestionId?: string | undefined;
  /** Una por intento: el reintento manual del mismo intento la reusa. */
  readonly idempotencyKey: string;
}

/**
 * `POST /blitz` → `202 { data: Content }` en `BUILDING`.
 *
 * `suggestionId` **sólo** viaja cuando la tarjeta salió de `GET /blitz/queue`.
 * El body de hoy es `.strict()` (`runBlitzRequestSchema`) y lo rechazaría con
 * `400`; pero sin él, aceptar "la tarjeta de arriba" es aceptar **la más nueva
 * de la cola** (`claimNextQueuedSuggestion` ordena `createdAt DESC`), y un
 * refill que entre entre el render y el swipe cambiaría cuál es. Las dos cosas
 * —listar y aceptar por id— tienen que llegar juntas al backend.
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
    mutationFn: ({ suggestionId, idempotencyKey }) =>
      apiRequest<Content>(BLITZ_ACCEPT_PATH, {
        method: "POST",
        body: suggestionId === undefined ? {} : { suggestionId },
        idempotencyKey,
        schema: contentSchema,
      }),
    onSuccess: (content) => {
      queryClient.setQueryData(queryKeys.contentItem(content._id), content);
      void queryClient.invalidateQueries({ queryKey: ["content"] });
    },
  });
}

/** `POST /blitz/queue/:id/discard` (propuesto). Rechazar no consume cuota (FR-050). */
export function useDiscardSuggestion(): UseMutationResult<void, ApiRequestError, string> {
  return useMutation<void, ApiRequestError, string>({
    mutationFn: (suggestionId) =>
      apiSend(blitzDiscardPath(suggestionId), { method: "POST" }),
  });
}
