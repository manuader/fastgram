"use client";

import {
  ANTI_BOT_DAILY_CAP_DEFAULT,
  LATER_STRATEGY_NETWORKS,
  STRATEGY_BRAND_GAP_MINUTES_MAX,
  STRATEGY_JITTER_MINUTES_MAX,
  STRATEGY_NETWORKS,
  STRATEGY_PER_DAY_MAX,
  STRATEGY_WEEKDAYS,
  STRATEGY_WINDOWS_PER_DAY_MAX,
  type NetworkStrategy,
  type Strategy,
  type StrategyNetwork,
  type StrategyWeekday,
  type UpdateStrategyRequest,
} from "@fastgram/contracts";
import { Badge, Button, Checkbox, Input, Skeleton } from "@fastgram/ui";
import { useEffect, useId, useMemo, useState, type ReactNode } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { NETWORK_LABEL } from "@/lib/calendar/board";
import { useSaveStrategy, useStrategy } from "./api";
import { AutopilotPolicyPanel } from "./AutopilotPolicy";
import { MixAutotuneToggle } from "@/components/analytics/MixPanel";
import { STRATEGY_COPY as COPY } from "./copy";

type Draft = UpdateStrategyRequest;

function toDraft(strategy: Strategy): Draft {
  // Una fila por red, en el orden de `D-09`: las que la estrategia no nombra
  // aparecen apagadas, así la pantalla siempre muestra las siete.
  const networks = STRATEGY_NETWORKS.map(
    (network): NetworkStrategy =>
      strategy.networks.find((n) => n.network === network) ?? {
        network,
        enabled: false,
        perDay: 1,
        dailyCap: ANTI_BOT_DAILY_CAP_DEFAULT,
      },
  );
  return {
    networks,
    windows: strategy.windows,
    timezone: strategy.timezone,
    language: strategy.language,
    autonomy: strategy.autonomy,
    jitterMinutes: strategy.jitterMinutes,
    brandGapMinutes: strategy.brandGapMinutes,
    formatMix: strategy.formatMix,
  };
}

/** Las zonas que conoce el navegador; si no sabe listarlas, un campo de texto. */
function knownTimeZones(): readonly string[] | null {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
  try {
    return intl.supportedValuesOf?.("timeZone") ?? null;
  } catch {
    return null;
  }
}

function clampInt(raw: string, min: number, max: number): number {
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/**
 * Settings → Strategy — `PU-BRAND-002` (`docs/PLAN-USO-PERSONAL.md` §2 paso 2
 * y §5; PRD `D-08`, `D-09`).
 *
 * Redes con piezas por día y tope anti-bot, horarios por día de la semana
 * (click para agregar una hora), autonomía, zona e idioma, y el ritmo (jitter
 * y separación entre marcas). Se guarda entera con `PUT /strategy`.
 *
 * Estados: `loading` (esqueletos), `error` (`ApiErrorState`) y `default`, que
 * acá es "la marca nunca guardó": se muestran los defaults y se dice.
 */
export function StrategySettings() {
  const query = useStrategy();

  if (query.isError) {
    return (
      <ApiErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4" aria-busy="true">
        <Skeleton height={160} />
        <Skeleton height={220} />
        <Skeleton height={120} />
      </div>
    );
  }
  return <StrategyForm strategy={query.data} />;
}

function StrategyForm({ strategy }: { readonly strategy: Strategy }) {
  const save = useSaveStrategy();
  const [draft, setDraft] = useState<Draft>(() => toDraft(strategy));
  const [savedOnce, setSavedOnce] = useState(false);

  // Si llega otra estrategia (se guardó, o se cambió de marca), se parte de ella.
  useEffect(() => {
    setDraft(toDraft(strategy));
  }, [strategy]);

  const zones = useMemo(knownTimeZones, []);
  const invalidNetworks = draft.networks.filter((n) => n.perDay > n.dailyCap);
  const canSave = invalidNetworks.length === 0 && !save.isPending;

  const setNetwork = (
    network: StrategyNetwork,
    patch: Partial<NetworkStrategy>,
  ): void => {
    setDraft((current) => ({
      ...current,
      networks: current.networks.map((n) =>
        n.network === network ? { ...n, ...patch } : n,
      ),
    }));
  };

  const setDay = (day: StrategyWeekday, times: readonly string[]): void => {
    setDraft((current) => ({
      ...current,
      windows: { ...current.windows, [day]: [...new Set(times)].sort() },
    }));
  };

  return (
    <form
      className="flex max-w-3xl flex-col gap-8"
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave) return;
        setSavedOnce(false);
        save.mutate(draft, {
          onSuccess: () => {
            setSavedOnce(true);
          },
        });
      }}
    >
      {strategy.isDefault && (
        <p className="m-0 rounded-md border border-border bg-surface-sunken p-3 text-sm text-text-muted">
          {COPY.defaultsNote}
        </p>
      )}

      <Section title={COPY.networksTitle} hint={COPY.networksHint}>
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {draft.networks.map((n) => (
            <NetworkRow
              key={n.network}
              value={n}
              onChange={(patch) => {
                setNetwork(n.network, patch);
              }}
            />
          ))}
        </div>
      </Section>

      <Section title={COPY.windowsTitle} hint={COPY.windowsHint}>
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {STRATEGY_WEEKDAYS.map((day) => (
            <DayWindows
              key={day}
              day={day}
              times={draft.windows[day]}
              onChange={(times) => {
                setDay(day, times);
              }}
            />
          ))}
        </div>
      </Section>

      <Section title={COPY.autonomyTitle}>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="fg-visually-hidden">{COPY.autonomyTitle}</legend>
          {(
            [
              ["manual", COPY.autonomyManual, COPY.autonomyManualHint],
              ["autopilot", COPY.autonomyAutopilot, COPY.autonomyAutopilotHint],
            ] as const
          ).map(([value, label, hint]) => (
            <label key={value} className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="autonomy"
                value={value}
                checked={draft.autonomy === value}
                onChange={() => {
                  setDraft((current) => ({ ...current, autonomy: value }));
                }}
                className="mt-1"
              />
              <span>
                <span className="font-medium text-text">{label}</span>
                <span className="block text-text-muted">{hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {/* `PU-AUTO-002`: qué hace el piloto y con qué umbrales. */}
        <AutopilotPolicyPanel />
        {/* `PU-AUTO-004`: se guarda al instante, aparte del botón Save. */}
        <div className="mt-3 rounded-lg border border-border p-3">
          <MixAutotuneToggle compact />
        </div>
      </Section>

      <Section title={COPY.localeTitle}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={COPY.timezone} hint={COPY.timezoneHint}>
            {(id, hintId) =>
              zones === null ? (
                <Input
                  id={id}
                  aria-describedby={hintId}
                  value={draft.timezone}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, timezone: event.target.value }));
                  }}
                />
              ) : (
                <select
                  id={id}
                  aria-describedby={hintId}
                  className="fg-input h-9 rounded-md border border-border bg-surface px-2 text-sm"
                  value={draft.timezone}
                  onChange={(event) => {
                    setDraft((current) => ({ ...current, timezone: event.target.value }));
                  }}
                >
                  {(zones.includes(draft.timezone)
                    ? zones
                    : [draft.timezone, ...zones]
                  ).map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </select>
              )
            }
          </Field>
          <Field label={COPY.language} hint={COPY.languageHint}>
            {(id, hintId) => (
              <Input
                id={id}
                aria-describedby={hintId}
                value={draft.language}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, language: event.target.value }));
                }}
              />
            )}
          </Field>
        </div>
      </Section>

      <Section title={COPY.pacingTitle}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={COPY.jitter} hint={COPY.jitterHint}>
            {(id, hintId) => (
              <Input
                id={id}
                type="number"
                min={0}
                max={STRATEGY_JITTER_MINUTES_MAX}
                aria-describedby={hintId}
                value={draft.jitterMinutes}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    jitterMinutes: clampInt(
                      event.target.value,
                      0,
                      STRATEGY_JITTER_MINUTES_MAX,
                    ),
                  }));
                }}
              />
            )}
          </Field>
          <Field label={COPY.brandGap} hint={COPY.brandGapHint}>
            {(id, hintId) => (
              <Input
                id={id}
                type="number"
                min={0}
                max={STRATEGY_BRAND_GAP_MINUTES_MAX}
                aria-describedby={hintId}
                value={draft.brandGapMinutes}
                onChange={(event) => {
                  setDraft((current) => ({
                    ...current,
                    brandGapMinutes: clampInt(
                      event.target.value,
                      0,
                      STRATEGY_BRAND_GAP_MINUTES_MAX,
                    ),
                  }));
                }}
              />
            )}
          </Field>
        </div>
      </Section>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={!canSave}>
          {save.isPending ? COPY.saving : COPY.save}
        </Button>
        <span aria-live="polite" className="text-sm text-text-muted">
          {savedOnce && !save.isPending && !save.isError ? COPY.saved : ""}
        </span>
      </div>
      {save.isError && (
        <div role="alert" className="flex flex-col gap-2">
          <p className="m-0 text-sm text-danger">{COPY.saveFailed}</p>
          <ApiErrorState error={save.error} />
        </div>
      )}
    </form>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  readonly title: string;
  readonly hint?: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div>
        <h2 id={id} className="m-0 text-lg font-semibold text-text">
          {title}
        </h2>
        {hint !== undefined && <p className="m-0 text-sm text-text-muted">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  readonly label: string;
  readonly hint: string;
  readonly children: (id: string, hintId: string) => ReactNode;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium text-text">
        {label}
      </label>
      {children(id, hintId)}
      <p id={hintId} className="m-0 text-xs text-text-muted">
        {hint}
      </p>
    </div>
  );
}

function NetworkRow({
  value,
  onChange,
}: {
  readonly value: NetworkStrategy;
  readonly onChange: (patch: Partial<NetworkStrategy>) => void;
}) {
  const name = NETWORK_LABEL[value.network];
  const later = LATER_STRATEGY_NETWORKS.includes(value.network);
  const perDayId = useId();
  const capId = useId();
  const messageId = useId();
  const overCap = value.perDay > value.dailyCap;
  const aboveDefault = value.dailyCap > ANTI_BOT_DAILY_CAP_DEFAULT;

  return (
    <div className="flex flex-col gap-2 p-3" data-network={value.network}>
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex min-w-[10rem] items-center gap-2">
          <Checkbox
            label={name}
            checked={value.enabled}
            onChange={(event) => {
              onChange({ enabled: event.target.checked });
            }}
          />
          {later && (
            <Badge tone="outline" size="sm" title={COPY.laterHint}>
              {COPY.later}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={perDayId} className="text-sm text-text-muted">
            {COPY.perDay}
          </label>
          <Input
            id={perDayId}
            type="number"
            min={0}
            max={STRATEGY_PER_DAY_MAX}
            className="w-20"
            disabled={!value.enabled}
            invalid={overCap}
            aria-describedby={overCap || aboveDefault ? messageId : undefined}
            value={value.perDay}
            onChange={(event) => {
              onChange({ perDay: clampInt(event.target.value, 0, STRATEGY_PER_DAY_MAX) });
            }}
          />
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor={capId} className="text-sm text-text-muted">
            {COPY.dailyCap}
          </label>
          <Input
            id={capId}
            type="number"
            min={1}
            max={STRATEGY_PER_DAY_MAX}
            className="w-20"
            disabled={!value.enabled}
            aria-describedby={overCap || aboveDefault ? messageId : undefined}
            value={value.dailyCap}
            onChange={(event) => {
              onChange({
                dailyCap: clampInt(event.target.value, 1, STRATEGY_PER_DAY_MAX),
              });
            }}
          />
        </div>
      </div>
      {(overCap || aboveDefault) && (
        <p
          id={messageId}
          role={overCap ? "alert" : "note"}
          className={`m-0 text-xs ${overCap ? "text-danger" : "text-warning"}`}
        >
          {overCap ? COPY.perDayOverCap : COPY.capWarning(ANTI_BOT_DAILY_CAP_DEFAULT)}
        </p>
      )}
    </div>
  );
}

/**
 * Las horas de un día: chips que se sacan con click, y un campo de hora con
 * "Add" para sumar otra. Se guardan ordenadas y sin repetir.
 */
function DayWindows({
  day,
  times,
  onChange,
}: {
  readonly day: StrategyWeekday;
  readonly times: readonly string[];
  readonly onChange: (times: readonly string[]) => void;
}) {
  const [pending, setPending] = useState("09:00");
  const dayName = COPY.days[day];
  const inputId = useId();
  const full = times.length >= STRATEGY_WINDOWS_PER_DAY_MAX;

  return (
    <div className="flex flex-wrap items-center gap-2 p-3" data-day={day}>
      <span className="w-24 text-sm font-medium text-text">{dayName}</span>
      <ul className="m-0 flex flex-1 flex-wrap gap-1 p-0" aria-label={dayName}>
        {times.length === 0 && (
          <li className="list-none text-sm text-text-muted">{COPY.noTimes}</li>
        )}
        {times.map((time) => (
          <li key={time} className="list-none">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              aria-label={COPY.removeTime(time, dayName)}
              onClick={() => {
                onChange(times.filter((t) => t !== time));
              }}
            >
              {time} ×
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-1">
        <label htmlFor={inputId} className="fg-visually-hidden">
          {COPY.addTime(dayName)}
        </label>
        <Input
          id={inputId}
          type="time"
          className="w-28"
          value={pending}
          onChange={(event) => {
            setPending(event.target.value);
          }}
        />
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={full || !/^\d{2}:\d{2}$/.test(pending)}
          aria-label={COPY.addTime(dayName)}
          onClick={() => {
            onChange([...times, pending]);
          }}
        >
          {COPY.addTimeButton}
        </Button>
      </div>
    </div>
  );
}
