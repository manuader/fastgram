"use client";

/**
 * Los datos del piloto automático · `PU-AUTO-003`. Lo usan la tarjeta de Today
 * (todas las marcas) y el banner de Blitz (la marca activa).
 *
 * `GET /autopilot/digest?brands=all` responde por **todas** las marcas del
 * dueño sin mandar un header por marca (igual que `/calendar?brands=all`: el
 * proxy sólo reenvía la marca de su cookie). Sin `date`, cada marca responde
 * **su** hoy, en su zona.
 *
 * Las claves cuelgan de `["autopilot", …]`, así que cambiar de marca
 * (`WorkspaceProvider` resetea todo lo que no es la lista de marcas) vuelve a
 * pedir la de la marca activa, que es lo correcto para el banner.
 */
import {
  autopilotDigestSchema,
  autopilotPolicySchema,
  type AutopilotDigest,
  type AutopilotPolicy,
  type AutopilotReason,
  type AutopilotRunOutcome,
} from "@fastgram/contracts";
import type { UseQueryResult } from "@tanstack/react-query";
import type { ApiRequestError } from "@/lib/api/errors";
import { useApiQuery } from "@/lib/api/hooks";
import type { CopyKey } from "@/lib/i18n/t";
import { TODAY_REFRESH_MS } from "@/lib/today/today";

export const AUTOPILOT_DIGEST_PATH = "autopilot/digest";
export const AUTOPILOT_POLICY_PATH = "autopilot/policy";

export const autopilotKeys = {
  digest: (brands: "current" | "all") => ["autopilot", "digest", brands] as const,
  policy: () => ["autopilot", "policy"] as const,
};

export function useAutopilotDigest(
  brands: "current" | "all",
): UseQueryResult<AutopilotDigest, ApiRequestError> {
  return useApiQuery<AutopilotDigest>({
    queryKey: autopilotKeys.digest(brands),
    path: AUTOPILOT_DIGEST_PATH,
    query: { brands },
    schema: autopilotDigestSchema,
    refetchInterval: TODAY_REFRESH_MS,
  });
}

export function useAutopilotPolicy(): UseQueryResult<AutopilotPolicy, ApiRequestError> {
  return useApiQuery<AutopilotPolicy>({
    queryKey: autopilotKeys.policy(),
    path: AUTOPILOT_POLICY_PATH,
    schema: autopilotPolicySchema,
    // No cambia sin un deploy.
    staleTime: Infinity,
  });
}

export const reasonKey = (reason: AutopilotReason): CopyKey =>
  `autopilot.reason.${reason}`;

/** Los resultados de corrida que se le cuentan al usuario. `ran` y `manual` no. */
export function outcomeKey(outcome: AutopilotRunOutcome): CopyKey | null {
  switch (outcome) {
    case "no_llm":
    case "no_judgment":
    case "invalid_strategy":
    case "profile_not_ready":
    case "error":
      return `autopilot.outcome.${outcome}`;
    case "ran":
    case "manual":
      return null;
  }
}

/** Los motivos de un conjunto de rechazos, contados y del más al menos frecuente. */
export function reasonTally(
  items: readonly { readonly reasons: readonly AutopilotReason[] }[],
): { readonly reason: AutopilotReason; readonly count: number }[] {
  const counts = new Map<AutopilotReason, number>();
  for (const item of items) {
    for (const reason of new Set(item.reasons)) {
      counts.set(reason, (counts.get(reason) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([reason, count]) => ({ reason, count }))
    .sort((a, b) => b.count - a.count || (a.reason < b.reason ? -1 : 1));
}
