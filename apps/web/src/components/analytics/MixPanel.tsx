"use client";

import {
  analyticsMixSchema,
  type AnalyticsMix,
  type MixAdjustment,
} from "@fastgram/contracts";
import { Skeleton, Switch } from "@fastgram/ui";
import { copyKeyForError } from "@/lib/api/errors";
import {
  ANALYTICS_FORMATS,
  FORMAT_COLOR,
  formatAgo,
  signedDelta,
} from "@/lib/analytics/format";
import { useAnalyticsMix, useSetAutotune } from "@/lib/analytics/data";
import { tw, type CopyKey } from "@/lib/i18n/t";

const formatKey = (f: string): CopyKey => `analytics.format.${f}` as CopyKey;

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });

/**
 * La respuesta revalidada acá además de en el cliente: si el cliente está
 * mockeado o una API vieja responde otra cosa, este panel muestra su error en
 * vez de romper la pantalla que lo contiene (Strategy), igual que
 * `AutopilotPolicyPanel`.
 */
function parsedMix(data: unknown): AnalyticsMix | null {
  const parsed = analyticsMixSchema.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/**
 * El interruptor "Auto-tune content mix" (`PU-AUTO-004`), solo. Lo usan este
 * panel y Settings → Strategy: aplica **al instante** (es un switch, no un
 * campo del formulario de la estrategia) y los dos leen la misma caché.
 *
 * El error de carga no es un botón "Try again": en Strategy compartiría
 * pantalla con el reintento de la estrategia y serían dos botones iguales.
 */
export function MixAutotuneToggle({ compact = false }: { readonly compact?: boolean }) {
  const mix = useAnalyticsMix();
  // Sin toast a propósito: Settings → Strategy no monta un `ToastProvider`
  // en sus tests y el error se lee mejor pegado al interruptor.
  const setAutotune = useSetAutotune();

  if (mix.isPending) return <Skeleton width={220} height={20} />;
  const data = mix.isError ? null : parsedMix(mix.data);
  if (data === null) {
    return <p className="m-0 text-xs text-danger">{tw("analytics.mix.error")}</p>;
  }
  const { autotune } = data;
  const busy = setAutotune.isPending;

  return (
    <div className="flex flex-col gap-1" data-testid="mix-autotune">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor="mix-autotune-switch" className="text-sm font-medium text-text">
          {tw("analytics.mix.autotune")}
        </label>
        <Switch
          id="mix-autotune-switch"
          checked={autotune.enabled}
          disabled={busy}
          aria-busy={busy}
          onCheckedChange={(enabled) => {
            setAutotune.mutate(enabled);
          }}
        />
      </div>
      {setAutotune.isError && (
        <p role="alert" className="m-0 text-xs text-danger">
          {tw("analytics.mix.autotuneFailed")} {tw(copyKeyForError(setAutotune.error))}
        </p>
      )}
      <p className="m-0 text-xs text-text-muted">{tw("analytics.mix.autotuneHint")}</p>
      {!compact && autotune.enabled && (
        <p className="m-0 text-xs text-text-muted" data-testid="mix-last-run">
          {autotune.lastRunAt === null || autotune.lastOutcome === null
            ? tw("analytics.mix.neverRun")
            : tw("analytics.mix.lastRun", {
                when: formatAgo(autotune.lastRunAt, Date.now()),
                outcome: tw(`analytics.mix.outcome.${autotune.lastOutcome}` as CopyKey),
              })}
        </p>
      )}
    </div>
  );
}

function WeightBars({ weights }: { readonly weights: AnalyticsMix["weights"] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0" data-testid="mix-weights">
      {ANALYTICS_FORMATS.map((f) => (
        <li key={f} className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-text">{tw(formatKey(f))}</span>
            <span className="tabular-nums text-text-muted">{weights[f]}</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
            <div
              className="h-full rounded-full"
              style={{ width: `${String(weights[f])}%`, background: FORMAT_COLOR[f] }}
            />
          </div>
        </li>
      ))}
    </ul>
  );
}

function Adjustment({ item }: { readonly item: MixAdjustment }) {
  const measured = Object.values(item.samples).reduce((a, b) => a + b, 0);
  return (
    <li className="flex flex-col gap-1 border-t border-border pt-2 first:border-t-0 first:pt-0">
      <p className="m-0 text-xs text-text-muted">
        {tw("analytics.mix.change", { date: DATE.format(item.createdAt) })}
        {measured > 0 && ` · ${tw("analytics.mix.samples", { n: measured })}`}
      </p>
      <ul className="m-0 flex list-none flex-wrap gap-x-3 gap-y-1 p-0 text-xs">
        {ANALYTICS_FORMATS.filter((f) => item.from[f] !== item.to[f]).map((f) => (
          <li key={f} className="tabular-nums text-text">
            {tw(formatKey(f))} {item.from[f]} → {item.to[f]}{" "}
            <span
              className={item.to[f] > item.from[f] ? "text-success" : "text-text-muted"}
            >
              ({signedDelta(item.from[f], item.to[f])})
            </span>
          </li>
        ))}
      </ul>
    </li>
  );
}

/**
 * Panel del content mix en `/analytics`: los pesos actuales de la marca, el
 * auto-tune y el historial de cambios («quién/cuándo/de qué a qué»).
 */
export function MixPanel() {
  const mix = useAnalyticsMix();
  const data = mix.isPending || mix.isError ? null : parsedMix(mix.data);
  return (
    <section
      aria-labelledby="analytics-mix-title"
      className="flex flex-col gap-4 rounded-xl border border-border bg-surface p-4"
    >
      <header className="flex flex-col gap-0.5">
        <h2 id="analytics-mix-title" className="m-0 text-lg font-semibold text-text">
          {tw("analytics.mix.title")}
        </h2>
        <p className="m-0 text-xs text-text-muted">{tw("analytics.mix.hint")}</p>
      </header>
      {mix.isPending ? (
        <div className="flex flex-col gap-2" aria-busy>
          {ANALYTICS_FORMATS.map((f) => (
            <Skeleton key={f} height={14} />
          ))}
        </div>
      ) : data === null ? (
        <p className="m-0 text-sm text-danger">{tw("analytics.mix.error")}</p>
      ) : (
        <>
          <WeightBars weights={data.weights} />
          <MixAutotuneToggle />
          <div className="flex flex-col gap-2">
            <h3 className="m-0 text-sm font-semibold text-text">
              {tw("analytics.mix.history")}
            </h3>
            {data.adjustments.length === 0 ? (
              <p className="m-0 text-xs text-text-muted">
                {tw("analytics.mix.historyEmpty")}
              </p>
            ) : (
              <ul
                className="m-0 flex list-none flex-col gap-2 p-0"
                data-testid="mix-history"
              >
                {data.adjustments.map((a) => (
                  <Adjustment key={a._id} item={a} />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </section>
  );
}
