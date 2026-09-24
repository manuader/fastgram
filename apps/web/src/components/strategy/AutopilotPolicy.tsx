"use client";

import { autopilotPolicySchema, type AutopilotPolicy } from "@fastgram/contracts";
import { Skeleton } from "@fastgram/ui";
import { useAutopilotPolicy } from "@/components/today/autopilot-data";
import { STRATEGY_COPY as COPY } from "./copy";

const pct = (p: number): string => `${String(Math.round(p * 100))}%`;

/**
 * "How autopilot decides" · `PU-AUTO-002`. Sólo lectura: los números salen de
 * `GET /autopilot/policy`, que los lee de `@fastgram/core` —no hay una segunda
 * copia acá—. Editarlos sería otra tarea: hoy son código (§9.15.3 regla 2,
 * recalculables sobre las respuestas guardadas), no configuración por marca.
 *
 * Plegado por defecto: es la explicación, no la decisión. La decisión es el
 * radio de arriba.
 */
export function AutopilotPolicyPanel() {
  const query = useAutopilotPolicy();
  // Se revalida acá además de en el cliente: si el cliente está mockeado o una
  // versión vieja de la API responde otra cosa, se muestra el error en vez de
  // romper la pantalla de Strategy por un panel explicativo.
  const parsed = autopilotPolicySchema.safeParse(query.data);

  return (
    <details
      className="mt-3 rounded-lg border border-border p-3 text-sm"
      data-testid="autopilot-policy"
    >
      <summary className="cursor-pointer font-medium text-text">
        {COPY.autopilotHowTitle}
      </summary>
      <ol className="mt-2 list-decimal space-y-1 pl-5 text-text-muted">
        {COPY.autopilotHowSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      {query.isPending ? (
        <Skeleton width={180} height={12} className="mt-3" />
      ) : parsed.success ? (
        <Numbers policy={parsed.data} />
      ) : (
        <p className="mt-3 text-xs text-danger">{COPY.autopilotPolicyError}</p>
      )}
      <p className="mt-3 text-xs text-text-muted">{COPY.autopilotModelHint}</p>
    </details>
  );
}

function Numbers({ policy }: { readonly policy: AutopilotPolicy }) {
  const t = policy.thresholds;
  return (
    <div className="mt-3 grid gap-3 sm:grid-cols-2">
      <ul className="space-y-1 text-xs text-text-muted">
        <li>{COPY.autopilotHorizon(policy.horizonDays)}</li>
        <li>{COPY.autopilotQueue(policy.queueTargetMin, policy.queueTargetMax)}</li>
        <li>{COPY.autopilotPerRun(policy.maxDecisionsPerRun)}</li>
        <li>{COPY.autopilotTimeout(Math.round(policy.precheckTimeoutMs / 1000))}</li>
      </ul>
      <div>
        <p className="mb-1 text-xs font-medium text-text">
          {COPY.autopilotThresholdsTitle}
        </p>
        <ul
          className="space-y-1 text-xs text-text-muted"
          data-testid="autopilot-thresholds"
        >
          <li>{COPY.autopilotThresholds.onBrandMin(pct(t.onBrandMin))}</li>
          <li>{COPY.autopilotThresholds.riskyClaimMaxMass(pct(t.riskyClaimMaxMass))}</li>
          <li>{COPY.autopilotThresholds.thirdPartyMax(pct(t.thirdPartyMax))}</li>
          <li>{COPY.autopilotThresholds.coherentMin(pct(t.coherentMin))}</li>
          <li>{COPY.autopilotThresholds.inLanguageMin(pct(t.inLanguageMin))}</li>
        </ul>
      </div>
    </div>
  );
}
