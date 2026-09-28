"use client";

import type { LearnedPreference, PreferencesView } from "@fastgram/contracts";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Select,
  Skeleton,
  Switch,
} from "@fastgram/ui";
import { useId, useRef, useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw } from "@/lib/i18n/t";
import {
  usePreferencesView,
  useResetPreferences,
  useUpdatePreferenceSettings,
  type PreferenceScope,
} from "./api";
import { phraseOf } from "./phrases";

/** Opciones de exploración (0–50 %, `D-22`). El default es 15 %. */
export const EXPLORATION_OPTIONS = [
  0, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.4, 0.5,
] as const;
/** Vida media, en días. El default es 30. */
export const HALF_LIFE_OPTIONS = [7, 14, 30, 60, 90, 180] as const;

/** Valor del `<select>` que significa «heredar el default del dueño». */
const INHERIT = "";

const percent = (v: number): string =>
  tw("learned.settings.percent", { value: Math.round(v * 100) });
const days = (v: number): string => tw("learned.settings.days", { days: v });

/**
 * «What Blitz learned» — sprint 9 (Q), `PU-S9-011`, `D-22`. Se monta en
 * `/blitz/settings`, debajo del formulario de preferencias de Blitz.
 *
 * Dos vistas: **esta marca** (`GET /preferences`, con el dueño como prior) y
 * **todas mis marcas** (`GET /preferences/owner`). Cada rasgo es una frase
 * armada por código ({@link phraseOf}) con su evidencia («12 of 14»).
 *
 * Estados: loading (esqueleto), error (con reintento), empty (nada aprendido
 * todavía, con cuántas decisiones van). La configuración se guarda al cambiar
 * cada control —son tres valores sueltos, sin un borrador que valga la pena—
 * y el reset pide confirmación en un diálogo.
 */
export function WhatBlitzLearned() {
  const titleId = useId();
  const [scope, setScope] = useState<PreferenceScope>("brand");
  const query = usePreferencesView(scope);

  return (
    <div className="fgw-prefs">
      <section className="fgw-prefs__section" aria-labelledby={titleId}>
        <h2 id={titleId} className="fgw-prefs__heading">
          {tw("learned.title")}
        </h2>
        <p className="fgw-prefs__hint">{tw("learned.intro")}</p>

        <div
          className="fgw-prefs__row"
          role="group"
          aria-label={tw("learned.scope.label")}
        >
          {(["brand", "owner"] as const).map((s) => (
            <Button
              key={s}
              type="button"
              size="sm"
              variant={scope === s ? "secondary" : "ghost"}
              aria-pressed={scope === s}
              onClick={() => {
                setScope(s);
              }}
            >
              {tw(s === "brand" ? "learned.scope.brand" : "learned.scope.owner")}
            </Button>
          ))}
        </div>

        {query.isPending ? (
          <div role="status" aria-label={tw("learned.loading")}>
            <Skeleton height="1.25rem" />
            <Skeleton height="1.25rem" />
            <Skeleton height="1.25rem" />
          </div>
        ) : query.isError ? (
          <ApiErrorState
            error={query.error}
            onRetry={() => {
              void query.refetch();
            }}
          />
        ) : (
          <LearnedBody view={query.data} scope={scope} />
        )}
      </section>
    </div>
  );
}

function LearnedBody({ view, scope }: { view: PreferencesView; scope: PreferenceScope }) {
  const rows = view.learned
    .map((item) => ({ item, phrase: phraseOf(item) }))
    .filter(
      (r): r is { item: LearnedPreference; phrase: NonNullable<typeof r.phrase> } =>
        r.phrase !== null,
    );
  const decisions =
    view.signals.total === 1
      ? tw("learned.decisions.one")
      : tw("learned.decisions.other", { count: view.signals.total });

  return (
    <>
      {rows.length === 0 ? (
        <EmptyState
          title={tw("learned.empty.title")}
          description={
            <>
              {tw("learned.empty.body")} {decisions}
            </>
          }
        />
      ) : (
        <>
          <p className="fgw-prefs__note">{decisions}</p>
          <ul className="fgw-prefs" aria-label={tw("learned.title")}>
            {rows.map(({ item, phrase }) => (
              <li
                key={item.feature}
                className="fgw-prefs__row"
                data-direction={item.direction}
              >
                <span className="fgw-prefs__label">
                  {phrase.text}
                  {scope === "brand" && item.source === "owner" && (
                    <span className="fgw-prefs__hint">
                      {" "}
                      · {tw("learned.fromOtherBrands")}
                    </span>
                  )}
                </span>
                <span className="fgw-prefs__hint">{phrase.evidence}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <SettingsPanel view={view} scope={scope} />
    </>
  );
}

function SettingsPanel({
  view,
  scope,
}: {
  view: PreferencesView;
  scope: PreferenceScope;
}) {
  const update = useUpdatePreferenceSettings(scope);
  const explorationId = useId();
  const memoryId = useId();
  const [confirming, setConfirming] = useState(false);
  const inherited = (src: "brand" | "owner") => scope === "brand" && src === "owner";

  const explorationValue = inherited(view.settings.explorationSource)
    ? INHERIT
    : String(view.settings.exploration);
  const memoryValue = inherited(view.settings.halfLifeSource)
    ? INHERIT
    : String(view.settings.halfLifeDays);

  const explorationOptions = [
    ...(scope === "brand"
      ? [
          {
            value: INHERIT,
            label: tw("learned.settings.default", {
              value: percent(view.ownerDefaults.exploration),
            }),
          },
        ]
      : []),
    ...withCurrent(EXPLORATION_OPTIONS, view.settings.exploration).map((v) => ({
      value: String(v),
      label: percent(v),
    })),
  ];
  const memoryOptions = [
    ...(scope === "brand"
      ? [
          {
            value: INHERIT,
            label: tw("learned.settings.default", {
              value: days(view.ownerDefaults.halfLifeDays),
            }),
          },
        ]
      : []),
    ...withCurrent(HALF_LIFE_OPTIONS, view.settings.halfLifeDays).map((v) => ({
      value: String(v),
      label: days(v),
    })),
  ];

  return (
    <div className="fgw-prefs__section">
      <h3 className="fgw-prefs__heading">{tw("learned.settings.heading")}</h3>

      {scope === "brand" && (
        <div className="fgw-prefs__row">
          <span className="fgw-prefs__label">{tw("learned.settings.enabled")}</span>
          <Switch
            checked={view.settings.enabled}
            aria-label={tw("learned.settings.enabled")}
            disabled={update.isPending}
            onCheckedChange={(enabled) => {
              update.mutate({ enabled });
            }}
          />
        </div>
      )}

      <div className="fgw-prefs__row">
        <label className="fgw-prefs__label" htmlFor={explorationId}>
          {tw("learned.settings.exploration")}
        </label>
        <Select
          id={explorationId}
          value={explorationValue}
          options={explorationOptions}
          disabled={update.isPending}
          onChange={(event) => {
            const raw = event.target.value;
            update.mutate({ exploration: raw === INHERIT ? null : Number(raw) });
          }}
        />
      </div>
      <p className="fgw-prefs__hint">{tw("learned.settings.explorationHint")}</p>

      <div className="fgw-prefs__row">
        <label className="fgw-prefs__label" htmlFor={memoryId}>
          {tw("learned.settings.memory")}
        </label>
        <Select
          id={memoryId}
          value={memoryValue}
          options={memoryOptions}
          disabled={update.isPending}
          onChange={(event) => {
            const raw = event.target.value;
            update.mutate({ halfLifeDays: raw === INHERIT ? null : Number(raw) });
          }}
        />
      </div>
      <p className="fgw-prefs__hint">{tw("learned.settings.memoryHint")}</p>

      {update.isError && (
        <p className="fgw-field__error" role="alert">
          {tw("learned.settings.saveFailed")}
        </p>
      )}

      <div className="fgw-prefs__row">
        <span />
        <Button
          type="button"
          variant="danger"
          size="sm"
          onClick={() => {
            setConfirming(true);
          }}
        >
          {tw(scope === "brand" ? "learned.reset.brand" : "learned.reset.owner")}
        </Button>
      </div>

      <ResetDialog
        open={confirming}
        scope={scope}
        onClose={() => {
          setConfirming(false);
        }}
      />
    </div>
  );
}

/** Las opciones fijas más el valor actual si es otro (un PATCH por API). */
function withCurrent(options: readonly number[], current: number): number[] {
  return options.includes(current)
    ? [...options]
    : [...options, current].sort((a, b) => a - b);
}

function ResetDialog({
  open,
  scope,
  onClose,
}: {
  open: boolean;
  scope: PreferenceScope;
  onClose: () => void;
}) {
  const reset = useResetPreferences();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    reset.reset();
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} size="sm" initialFocusRef={cancelRef}>
      <DialogHeader>
        <DialogTitle>
          {tw(
            scope === "brand" ? "learned.reset.titleBrand" : "learned.reset.titleOwner",
          )}
        </DialogTitle>
        <DialogDescription>
          {tw(scope === "brand" ? "learned.reset.bodyBrand" : "learned.reset.bodyOwner")}
        </DialogDescription>
        <DialogClose label={tw("common.close")} />
      </DialogHeader>
      {reset.isError && (
        <DialogBody>
          <p className="fgw-field__error" role="alert">
            {tw("learned.reset.failed")}
          </p>
        </DialogBody>
      )}
      <DialogFooter>
        <Button ref={cancelRef} type="button" variant="ghost" onClick={close}>
          {tw("common.cancel")}
        </Button>
        <Button
          type="button"
          variant="danger"
          loading={reset.isPending}
          onClick={() => {
            reset.mutate(scope, { onSuccess: close });
          }}
        >
          {tw("learned.reset.confirm")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
