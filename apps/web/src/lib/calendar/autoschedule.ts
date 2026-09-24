"use client";

/**
 * Aprobar → auto-slot — `PU-CAL-001`.
 *
 * `useAutoschedule(contentId)` llama a `POST /content/:id/autoschedule`: la API
 * busca el próximo horario libre de cada red activa de la estrategia de la
 * marca y crea un post (si la marca tiene la conexión) o un slot planificado
 * (si no). Lo usan el detalle de la pieza (`Auto-slot`, sprint 7) y, con su
 * propia llamada, el "Schedule Post" del diálogo de aceptar en Blitz.
 *
 * Uso esperado:
 *
 * ```tsx
 * const schedule = useAutoschedule(contentId);
 * schedule.mutate(undefined, {
 *   onSuccess: (result) => toast(describeAutoschedule(result)),
 * });
 * ```
 *
 * Errores que conviene distinguir en la UI (`error.code`):
 * - `conflict` — la marca no tiene ninguna red activa en su estrategia: el
 *   remedio es ir a Settings → Strategy.
 * - `unsupported_content_state` — la pieza falló al construirse.
 * - `service_unavailable` — hacía falta crear un post y la cola no está.
 */
import {
  autoscheduleResultSchema,
  type AutoscheduleResult,
  type StrategyNetwork,
} from "@fastgram/contracts";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { tw } from "../i18n/t";
import { NETWORK_LABEL } from "./board";

export function autoschedulePath(contentId: string): string {
  return `content/${encodeURIComponent(contentId)}/autoschedule`;
}

export interface AutoscheduleVariables {
  /** Limitar a estas redes. Sin esto, todas las activas de la estrategia. */
  readonly networks?: readonly StrategyNetwork[];
}

export function useAutoschedule(contentId: string) {
  const queryClient = useQueryClient();
  return useMutation<AutoscheduleResult, ApiRequestError, AutoscheduleVariables | void>({
    mutationFn: (variables) =>
      apiRequest<AutoscheduleResult>(autoschedulePath(contentId), {
        method: "POST",
        body:
          variables === undefined || variables.networks === undefined
            ? {}
            : { networks: variables.networks },
        schema: autoscheduleResultSchema,
      }),
    // Los posts nuevos y los slots aparecen en la Library y en el calendario.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["posts"] }),
  });
}

/**
 * Una línea para el toast: cuántas redes quedaron y la primera hora, en la
 * zona del navegador. `null` si no se programó nada (todas `skipped`).
 */
export function describeAutoschedule(
  result: AutoscheduleResult,
  timeZone: string,
): string | null {
  const scheduled = [
    ...result.posts.map((p) => ({ network: p.platform as string, at: p.scheduledAtUtc })),
    ...result.plannedSlots.map((s) => ({
      network: s.network as string,
      at: s.scheduledAtUtc,
    })),
  ].sort((a, b) => a.at - b.at);
  const first = scheduled[0];
  if (first === undefined) return null;
  const when = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  })
    .format(new Date(first.at))
    .replace(/\s+/g, " ");
  const names = scheduled.map(
    (s) => NETWORK_LABEL[s.network as keyof typeof NETWORK_LABEL] ?? s.network,
  );
  return tw("calendar.autoschedule.done", { networks: names.join(", "), when });
}
