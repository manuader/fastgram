/**
 * Configuración de TanStack Query · `P1-UI-007`.
 *
 * Los defaults de la librería están pensados para una app cualquiera; los de
 * aquí están pensados para **esta**, y cada uno tiene un porqué:
 *
 * · `retry`: nunca se reintenta un 4xx. Un `content_quota_exceeded` reintentado
 *   tres veces sigue siendo cuota agotada, y entre medias el usuario mira una
 *   pantalla en blanco tres veces más tiempo. Los 5xx y los fallos de red sí.
 *   El `429` es la excepción **sólo** con `code: rate_limited` (ERR-R01): la
 *   cuota agotada también es `429` (ERR-R02/R03) y no se recupera esperando
 *   segundos. Se mira el `code`, no el status.
 * · `staleTime` de 30 s: la mayoría de los listados cambian por acción del
 *   usuario, no solos. Refetchear en cada foco de ventana gasta rate limit
 *   (§9.8) sin enseñar nada nuevo.
 */
import { QueryClient, type QueryClientConfig } from "@tanstack/react-query";
import { isApiRequestError } from "./errors";

export const MAX_RETRIES = 2;

export function shouldRetry(failureCount: number, error: unknown): boolean {
  if (failureCount >= MAX_RETRIES) return false;
  if (!isApiRequestError(error)) return false;
  if (error.code === "network_error" || error.code === "timeout") return true;
  // 408 y el 429 de rate limit son recuperables; el resto de 4xx, no. Un 429
  // de cuota (`content_quota_exceeded`, `blitz_quota_exceeded`) no lo es.
  if (error.status === 408) return true;
  if (error.status === 429) return error.code === "rate_limited";
  return error.status >= 500;
}

export const queryClientConfig: QueryClientConfig = {
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: shouldRetry,
    },
    // Una mutación reintentada sola puede duplicar un efecto. Quien quiera
    // reintentar, que lo pida — con `Idempotency-Key` (PRD:2288).
    mutations: { retry: false },
  },
};

export function createQueryClient(): QueryClient {
  return new QueryClient(queryClientConfig);
}
