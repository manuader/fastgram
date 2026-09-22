"use client";

import { Skeleton } from "@fastgram/ui";
import { useQuery } from "@tanstack/react-query";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { queryKeys } from "@/lib/api/keys";
import type { ApiRequestError } from "@/lib/api/errors";
import {
  fetchServiceStatus,
  STATUS_POLL_INTERVAL_MS,
  type ServiceState,
  type ServiceStatus as ServiceStatusPayload,
} from "@/lib/status/health";

/**
 * Estado → copy. El `Record` es completo, no un `switch` con `default`: el día
 * que `apps/api` añada un cuarto estado, esto deja de compilar y alguien decide
 * qué lee el visitante, en vez de que un estado nuevo se dibuje como el
 * genérico —que en esta pantalla sería, casi seguro, "todo bien"—.
 *
 * El copy no nombra ninguna dependencia, y eso es la decisión, no una
 * limitación del texto: ver la cabecera de `lib/status/health.ts`.
 */
const SERVICE_STATE_COPY: Readonly<
  Record<ServiceState, { readonly title: CopyKey; readonly description: CopyKey }>
> = {
  ok: { title: "status.ok.title", description: "status.ok.description" },
  degraded: {
    title: "status.degraded.title",
    description: "status.degraded.description",
  },
  unavailable: {
    title: "status.unavailable.title",
    description: "status.unavailable.description",
  },
};

/**
 * La hora del último chequeo, en UTC.
 *
 * Misma decisión que `lib/media/media.ts` y `lib/library/posts.ts`: sin fijar
 * la zona, `Intl` usa la de la máquina. Acá pesa más que en las otras dos —dos
 * personas comparando notas durante un incidente tienen que estar mirando el
 * mismo reloj, y el reloj de un incidente es UTC—.
 *
 * El dato existe porque una página de estado sin hora no se puede creer: sin
 * ella, un "All systems operational" pintado hace cuarenta minutos se lee igual
 * que uno de hace dos segundos.
 */
const checkedAtFormat = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
  timeZone: "UTC",
});

/**
 * `/status` · F-255 (PRD:721), `P1-OBS-004`.
 *
 * Enseña **una** cosa: el estado global del servicio, sacado del cuerpo de los
 * health checks de `apps/api` y redactado del lado del servidor por
 * `app/api/fastgram/status/route.ts`.
 *
 * ## Lo que no está, y por qué
 *
 * - **Ningún desglose por dependencia.** Es la decisión central de la tarea y
 *   está argumentada en `lib/status/health.ts`: esta página es pública, y
 *   publicar qué subsistema está débil durante un incidente es decirle a
 *   cualquiera dónde empujar.
 * - **Ningún histórico ni incidentes.** F-255 dice *"estado del servicio"* y
 *   nada más; no hay endpoint de incidentes ni modelo que los guarde.
 *   Dibujar noventa días de cuadraditos verdes que nadie calculó sería inventar
 *   un dato.
 * - **`GET /health/live` no se consulta.** Contesta 200 mientras el proceso
 *   conteste, o sea que para un visitante es una constante: si estuviera caído,
 *   esta página tampoco cargaría.
 *
 * ## El refresco
 *
 * Se vuelve a preguntar cada {@link STATUS_POLL_INTERVAL_MS}, con `staleTime: 0`
 * para que no haya que resolver a mano cómo se combinan una ventana de frescura
 * y una cadencia. En una pestaña de fondo el intervalo **no dispara**
 * (`refetchIntervalInBackground: false` de TanStack Query), que es lo deseable:
 * una página de estado abierta y olvidada en una pestaña no tiene que sondear
 * para siempre. La región es `aria-live="polite"` porque el contenido cambia
 * **solo**, sin que nadie toque nada.
 */
export function ServiceStatus() {
  const query = useQuery<ServiceStatusPayload, ApiRequestError>({
    queryKey: queryKeys.serviceStatus(),
    queryFn: ({ signal }) => fetchServiceStatus(signal),
    staleTime: 0,
    refetchInterval: STATUS_POLL_INTERVAL_MS,
  });

  return (
    // Una sola región viva para las tres ramas: si cada rama trajera la suya,
    // el nodo se remontaría en cada cambio y un lector de pantalla no anunciaría
    // nada, que es justo lo contrario de lo que se busca acá.
    <section
      className="fgw-status"
      aria-live="polite"
      {...(query.isPending ? { "aria-busy": "true" as const } : {})}
    >
      {query.isPending ? (
        <div className="fgw-status__card" data-state="loading">
          <Skeleton shape="text" width="55%" />
          <Skeleton shape="text" width="75%" />
        </div>
      ) : query.isError ? (
        <ApiErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      ) : (
        <Report state={query.data.state} checkedAt={query.dataUpdatedAt} />
      )}

      {/* La política de la página, dicha en la página. Un lector que no sabe
          que el desglose se omite a propósito lo lee como una página a medio
          hacer. */}
      <p className="fgw-status__scope">{tw("status.scope")}</p>
    </section>
  );
}

function Report({ state, checkedAt }: { state: ServiceState; checkedAt: number }) {
  const copy = SERVICE_STATE_COPY[state];
  const when = new Date(checkedAt);

  return (
    <div className="fgw-status__card" data-state={state}>
      {/* El color nunca es la única señal: el punto es decorativo y el estado
          va escrito al lado. */}
      <p className="fgw-status__headline">
        <span className="fgw-status__dot" aria-hidden="true" />
        {tw(copy.title)}
      </p>
      <p className="fgw-status__description">{tw(copy.description)}</p>
      <p className="fgw-status__meta">
        <time dateTime={when.toISOString()}>
          {tw("status.checkedAt", { time: checkedAtFormat.format(when) })}
        </time>
      </p>
    </div>
  );
}
