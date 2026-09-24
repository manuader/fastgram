"use client";

import type { CompanyProfile } from "@fastgram/contracts";
import { Button, Checkbox, Input, Select } from "@fastgram/ui";
import { useId, useState, type FormEvent } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import {
  MULTI_PROFILING_KEYS,
  OTHER_CHOICE,
  PROFILING_KEYS,
  PROFILING_OPTIONS,
  missingProfilingAnswers,
  profilingDraftFrom,
  toProfilingRequest,
  useSubmitProfiling,
  type ProfilingDraft,
  type ProfilingKey,
} from "@/lib/brand/intel";
import { tw, type CopyKey } from "@/lib/i18n/t";

/** Preguntas literales de `FR-010` (PRD:766). */
const QUESTION: Readonly<Record<ProfilingKey, CopyKey>> = {
  ownerRole: "brand.profiling.ownerRole",
  teamSize: "brand.profiling.teamSize",
  businessModel: "brand.profiling.businessModel",
  businessCategories: "brand.profiling.businessCategories",
  monthlyRevenueBand: "brand.profiling.monthlyRevenueBand",
  expectations: "brand.profiling.expectations",
};

/** Copy literal de `FR-010` (PRD:789) para las que faltan. */
const MISSING: Readonly<Partial<Record<ProfilingKey, CopyKey>>> = {
  ownerRole: "brand.profiling.missing.ownerRole",
  teamSize: "brand.profiling.missing.teamSize",
  businessModel: "brand.profiling.missing.businessModel",
  businessCategories: "brand.profiling.missing.businessCategories",
  monthlyRevenueBand: "brand.profiling.missing.monthlyRevenueBand",
};

/**
 * Cuestionario de perfilado — `P1-ONB-004`, `F-006`. Las seis preguntas del
 * paso 3 del alta, editables desde `/brand` sobre `POST /onboarding/profiling`
 * (el endpoint existía y ninguna pantalla lo llamaba).
 *
 * Las opciones no están en el PRD (ver `PROFILING_OPTIONS`); cada pregunta
 * acepta «Other» con texto. Estados: guardando, error de la API, faltantes
 * (antes de mandar), guardado.
 */
export function ProfilingCard({ profile }: { readonly profile: CompanyProfile }) {
  const baseId = useId();
  const [draft, setDraft] = useState<ProfilingDraft>(() => profilingDraftFrom(profile));
  const [missing, setMissing] = useState<ProfilingKey[]>([]);
  const submit = useSubmitProfiling();

  function choose(key: ProfilingKey, values: readonly string[]) {
    setDraft((d) => ({ ...d, chosen: { ...d.chosen, [key]: values } }));
    submit.reset();
  }
  function type(key: ProfilingKey, text: string) {
    setDraft((d) => ({ ...d, other: { ...d.other, [key]: text } }));
    submit.reset();
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const gaps = missingProfilingAnswers(draft);
    setMissing(gaps);
    if (gaps.length > 0) return;
    submit.mutate(toProfilingRequest(draft));
  }

  return (
    <section className="fgw-brand-section" aria-labelledby={`${baseId}-title`}>
      <header className="fgw-brand-section__header">
        <h2 id={`${baseId}-title`} className="fgw-brand-section__title">
          {tw("brand.profiling.title")}
        </h2>
      </header>
      <p className="fgw-brand__note">{tw("brand.profiling.body")}</p>
      <form
        className="fgw-brand-section__form"
        onSubmit={onSubmit}
        aria-busy={submit.isPending}
        noValidate
      >
        {PROFILING_KEYS.map((key) => {
          const id = `${baseId}-${key}`;
          const values = draft.chosen[key];
          const options = PROFILING_OPTIONS[key] as readonly string[];
          const missingKey = missing.includes(key) ? MISSING[key] : undefined;
          if (MULTI_PROFILING_KEYS.has(key)) {
            return (
              <fieldset key={key} className="fgw-brand-field">
                <legend className="fgw-brand-field__label">{tw(QUESTION[key])}</legend>
                <div className="grid gap-1 sm:grid-cols-2">
                  {options.map((option) => (
                    <Checkbox
                      key={option}
                      id={`${id}-${option}`}
                      label={option}
                      checked={values.includes(option)}
                      disabled={submit.isPending}
                      onChange={(e) => {
                        const checked = e.currentTarget.checked;
                        choose(
                          key,
                          checked
                            ? [...values, option]
                            : values.filter((v) => v !== option),
                        );
                      }}
                    />
                  ))}
                </div>
                <Input
                  aria-label={`${tw(QUESTION[key])} — ${tw("brand.profiling.other")}`}
                  placeholder={tw("brand.profiling.otherPlaceholderMany")}
                  value={draft.other[key]}
                  disabled={submit.isPending}
                  onChange={(e) => {
                    type(key, e.target.value);
                  }}
                />
                {missingKey !== undefined && (
                  <p className="fgw-brand-field__error" role="alert">
                    {tw(missingKey)}
                  </p>
                )}
              </fieldset>
            );
          }
          const selected = values[0] ?? "";
          return (
            <div key={key} className="fgw-brand-field">
              <label htmlFor={id} className="fgw-brand-field__label">
                {tw(QUESTION[key])}
              </label>
              <Select
                id={id}
                value={selected}
                placeholder={tw("brand.profiling.selectOne")}
                invalid={missingKey !== undefined}
                disabled={submit.isPending}
                aria-describedby={missingKey === undefined ? undefined : `${id}-err`}
                options={[
                  ...options.map((o) => ({ value: o, label: o })),
                  { value: OTHER_CHOICE, label: tw("brand.profiling.other") },
                ]}
                onChange={(e) => {
                  choose(key, [e.target.value]);
                }}
              />
              {selected === OTHER_CHOICE && (
                <Input
                  aria-label={`${tw(QUESTION[key])} — ${tw("brand.profiling.other")}`}
                  placeholder={tw("brand.profiling.otherPlaceholder")}
                  value={draft.other[key]}
                  disabled={submit.isPending}
                  onChange={(e) => {
                    type(key, e.target.value);
                  }}
                />
              )}
              {missingKey !== undefined && (
                <p id={`${id}-err`} className="fgw-brand-field__error" role="alert">
                  {tw(missingKey)}
                </p>
              )}
            </div>
          );
        })}

        {submit.isError && (
          <ApiErrorState
            error={submit.error}
            onRetry={() => {
              submit.mutate(toProfilingRequest(draft));
            }}
          />
        )}
        <div className="fgw-brand-section__actions">
          <Button type="submit" loading={submit.isPending} disabled={submit.isPending}>
            {tw(submit.isPending ? "brand.saving" : "brand.save")}
          </Button>
          {submit.isSuccess && (
            <span className="fgw-brand-section__saved" role="status">
              {tw("brand.profiling.saved")}
            </span>
          )}
        </div>
      </form>
    </section>
  );
}
