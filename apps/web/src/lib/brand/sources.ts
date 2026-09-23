/**
 * La tarjeta `Brand sources` de `/brand` · `F-024`, `FR-020`, §9.14, §19.5.1.
 * Tarea `P1-BRANDPG-002`.
 *
 * Listar, re-analizar, marcar primaria y quitar. **Añadir** reusa el alta del
 * onboarding (`useCreateBrandSource` en `lib/onboarding/brand-source.ts`), que
 * invalida el prefijo `brand-sources` — el mismo del que cuelga el listado de
 * acá (`queryKeys.brandSources`).
 *
 * ## Re-analizar no se reintenta, ni solo ni con un botón (NFR-005)
 *
 * `POST /brand/sources/:id/reanalyse` no lleva `Idempotency-Key` (el contrato no
 * la pide) y **cuenta contra el cupo diario** de la fuente (`ERR-B11`). Un
 * timeout no dice si el servidor lo aceptó: reintentar puede gastar un segundo
 * re-análisis, o chocar contra el `409` de "ya está analizando". NFR-005: *"El
 * cliente debe consultar estado"*. Así que ante **cualquier** fallo la mutación
 * vuelve a pedir el listado ({@link useReanalyseSource}) y la pantalla no
 * ofrece `Try again` ({@link presentSourceActionError}): lo que el usuario ve
 * después es el estado real de la fuente.
 */
import {
  brandSourceSchema,
  type BrandSource,
  type UpdateBrandSourceRequest,
} from "@fastgram/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiList, apiRequest, apiSend } from "../api/client";
import {
  brandErrorCodeOf,
  presentError,
  type ErrorPresentation,
} from "../api/error-presentation";
import { isApiRequestError, type ApiRequestError } from "../api/errors";
import { queryKeys } from "../api/keys";
import { BRAND_ANALYSIS_POLL_INTERVAL_MS, isInProgress } from "../onboarding/processing";

/**
 * Página que se pide. El cap es 5 (`MAX_BRAND_SOURCES_PER_WORKSPACE`) y el
 * listado **no** se pagina en pantalla: se pide una página holgada para que un
 * cap roto por otra vía se vea (seis filas) en vez de truncarse en silencio.
 */
const SOURCES_PAGE = 20;

/**
 * Primaria arriba, después por antigüedad. El orden del servidor es el del
 * cursor, que no es una promesa de producto.
 */
export function sortSources(sources: readonly BrandSource[]): BrandSource[] {
  return [...sources].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
    return a.createdAt - b.createdAt;
  });
}

export function anyInProgress(sources: readonly BrandSource[] | undefined): boolean {
  return sources?.some((s) => isInProgress(s.status)) ?? false;
}

/** `GET /brand/sources`, con polling mientras alguna fuente sigue en curso. */
export function useBrandSources(): UseQueryResult<BrandSource[], ApiRequestError> {
  return useQuery<BrandSource[], ApiRequestError>({
    queryKey: queryKeys.brandSources(),
    queryFn: async ({ signal }) => {
      const page = await apiList("/brand/sources", {
        signal,
        limit: SOURCES_PAGE,
        itemSchema: brandSourceSchema,
      });
      return sortSources(page.items);
    },
    refetchInterval: (query) =>
      anyInProgress(query.state.data) ? BRAND_ANALYSIS_POLL_INTERVAL_MS : false,
  });
}

/** Reemplaza una fuente en la caché del listado con la respuesta del servidor. */
function writeSource(queryClient: QueryClient, updated: BrandSource): void {
  queryClient.setQueryData<BrandSource[]>(queryKeys.brandSources(), (current) =>
    current === undefined
      ? current
      : sortSources(current.map((s) => (s._id === updated._id ? updated : s))),
  );
}

async function refreshSources(queryClient: QueryClient): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.brandSources() });
}

/**
 * `POST /brand/sources/:id/reanalyse` → `202` con la fuente en `analyzing`.
 *
 * `onSettled` y no `onSuccess`: tras un fallo también se relee el listado —es
 * la consulta de estado de NFR-005 (ver la cabecera)—. Tras un éxito, además,
 * el `202` ya trae la fuente y se escribe directo para que el badge cambie sin
 * esperar al `GET`.
 */
export function useReanalyseSource(): UseMutationResult<
  BrandSource,
  ApiRequestError,
  string
> {
  const queryClient = useQueryClient();
  return useMutation<BrandSource, ApiRequestError, string>({
    mutationFn: (id) =>
      apiRequest(`/brand/sources/${encodeURIComponent(id)}/reanalyse`, {
        method: "POST",
        schema: brandSourceSchema,
      }),
    retry: false,
    onSuccess: (updated) => {
      writeSource(queryClient, updated);
    },
    onSettled: () => refreshSources(queryClient),
  });
}

/**
 * `PATCH /brand/sources/:id` con `{isPrimary: true}`. Nunca `false`: la API lo
 * rechaza (siempre hay exactamente una primaria) y la operación que el usuario
 * quiere es promover otra. Se relee el listado porque la respuesta trae sólo la
 * promovida, y la anterior primaria también cambió.
 */
export function useSetPrimarySource(): UseMutationResult<
  BrandSource,
  ApiRequestError,
  string
> {
  const queryClient = useQueryClient();
  return useMutation<BrandSource, ApiRequestError, string>({
    mutationFn: (id) => {
      const body: UpdateBrandSourceRequest = { isPrimary: true };
      return apiRequest(`/brand/sources/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body,
        schema: brandSourceSchema,
      });
    },
    retry: false,
    onSettled: () => refreshSources(queryClient),
  });
}

/**
 * `DELETE /brand/sources/:id` → `204`. Se relee el listado siempre: borrar la
 * primaria promueve otra en el servidor, y un `404` (ya la borró otra pestaña)
 * se arregla mostrando el listado real.
 */
export function useRemoveSource(): UseMutationResult<void, ApiRequestError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiRequestError, string>({
    mutationFn: (id) =>
      apiSend(`/brand/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
    retry: false,
    onSettled: () => refreshSources(queryClient),
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Errores de las acciones de fila
// ───────────────────────────────────────────────────────────────────────────

export type SourceAction = "reanalyse" | "setPrimary" | "remove";

/**
 * Qué se dice cuando falla una acción del menú `⋯`.
 *
 * Sobre `presentError` —que ya traduce `ERR-B11` con sus horas y `ERR-B06`—,
 * tres casos que sin esto dirían algo falso:
 *
 * · **Quitar la única fuente** (`409` + `ERR-B01`). El copy de `ERR-B01` es el
 *   del onboarding (*"Add a website or a social profile to continue"*) y acá no
 *   hay nada que continuar. Se dice lo que la API dice —que es la única fuente
 *   detrás del perfil— con una clave propia, sin pintar el `message` crudo.
 * · **Quitar la primaria sin ser owner** (`403`, `FR-011.10`). `forbidden` a
 *   secas es *"Access Denied"*, que no dice qué regla es.
 * · **`404`**: la fuente ya no está (la quitó otra pestaña). El listado se
 *   relee solo; lo que se dice es eso, no un genérico.
 *
 * Y una regla para re-analizar: **nunca** `retry` (NFR-005, ver la cabecera).
 * La salida es mirar el estado, que el listado ya está trayendo.
 */
export function presentSourceActionError(
  action: SourceAction,
  error: unknown,
): ErrorPresentation {
  if (isApiRequestError(error)) {
    if (action === "remove" && brandErrorCodeOf(error) === "ERR-B01") {
      return { titleKey: "brand.sources.onlySource", remedy: "none" };
    }
    if (action === "remove" && error.code === "forbidden") {
      return { titleKey: "brand.sources.ownerOnly", remedy: "none" };
    }
    if (error.code === "not_found") {
      return { titleKey: "brand.sources.gone", remedy: "none" };
    }
  }
  const presented = presentError(error);
  if (action === "reanalyse" && presented.remedy === "retry") {
    return { ...presented, remedy: "none", descriptionKey: "brand.sources.checkStatus" };
  }
  return presented;
}
