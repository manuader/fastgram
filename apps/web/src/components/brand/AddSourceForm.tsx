"use client";

import { Button, Input } from "@fastgram/ui";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { tw } from "@/lib/i18n/t";
import { SOURCE_TYPE_COPY } from "@/lib/brand/source-types";
import {
  applyChip,
  CHIP_TYPES,
  createBodyOf,
  useBrandSourceDetection,
  useCreateBrandSource,
  type ChipType,
} from "@/lib/onboarding/brand-source";
import {
  ConfirmationCard,
  Disambiguator,
  InputProblem,
} from "@/components/onboarding/BrandSourceStep";

/**
 * `+ Add source` de la tarjeta `Brand sources` · `F-024`, FR-011.2 (PRD:844).
 *
 * Es el alta del paso 1 del onboarding con otra cáscara: la misma detección en
 * vivo contra `/resolve`, los mismos chips, la misma tarjeta con `Analyse` y la
 * misma `Idempotency-Key` por intento (`lib/onboarding/brand-source.ts`). Lo
 * que cambia es qué pasa al terminar: acá se cierra el formulario, y la fila
 * nueva aparece en la tarjeta porque el alta invalida el prefijo
 * `brand-sources`, del que cuelga el listado.
 *
 * `ERR-B10` (cap de 5) no se espera a que lo diga la API: con 5 fuentes el
 * botón que abre este formulario no se ofrece (`BrandSourcesCard`). Si igual
 * llega —otra pestaña añadió la quinta— el `400` sale traducido por
 * `InputProblem`.
 */
export function AddSourceForm({ onDone }: { readonly onDone: () => void }) {
  const inputId = useId();
  const feedbackId = useId();
  const [input, setInput] = useState("");
  const [chip, setChip] = useState<ChipType | null>(null);
  const field = useRef<HTMLInputElement>(null);

  const detection = useBrandSourceDetection(input, chip);
  const create = useCreateBrandSource();

  useEffect(() => {
    field.current?.focus();
  }, []);

  function changeInput(next: string) {
    setInput(next);
    if (create.isError) create.reset();
  }

  function pickChip(next: ChipType) {
    if (chip === next) {
      setChip(null);
      return;
    }
    setChip(next);
    changeInput(applyChip(input, next));
  }

  function analyse() {
    if (detection.kind !== "resolved" || !detection.result.available) return;
    create.mutate(createBodyOf(detection.result, detection.sourceType), {
      onSuccess: onDone,
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    analyse();
  }

  return (
    <form
      className="fgw-onb__form fgw-brand-sources__add"
      onSubmit={submit}
      noValidate
      aria-labelledby={`${inputId}-title`}
    >
      <h3 id={`${inputId}-title`} className="fgw-brand-sources__add-title">
        {tw("brand.sources.addTitle")}
      </h3>
      <label htmlFor={inputId} className="fg-visually-hidden">
        {tw("onboarding.source.inputLabel")}
      </label>
      <Input
        id={inputId}
        ref={field}
        type="text"
        inputMode="url"
        autoComplete="url"
        spellCheck={false}
        autoCapitalize="none"
        value={input}
        placeholder={tw("onboarding.source.placeholder")}
        invalid={detection.kind === "error"}
        aria-describedby={feedbackId}
        onChange={(e) => {
          changeInput(e.target.value);
        }}
      />

      <div
        className="fgw-onb__chips"
        role="group"
        aria-label={tw("onboarding.source.chipsLabel")}
      >
        {CHIP_TYPES.map((type) => (
          <Button
            key={type}
            type="button"
            size="sm"
            variant={chip === type ? "primary" : "secondary"}
            aria-pressed={chip === type}
            onClick={() => {
              pickChip(type);
            }}
          >
            {tw(SOURCE_TYPE_COPY[type])}
          </Button>
        ))}
      </div>

      <div id={feedbackId} className="fgw-onb__feedback" aria-live="polite">
        {detection.kind === "detecting" && (
          <p className="fgw-onb__hint">{tw("onboarding.source.detecting")}</p>
        )}
        {detection.kind === "error" && <InputProblem error={detection.error} />}
        {detection.kind === "ambiguous" && (
          <Disambiguator
            ambiguity={detection.ambiguity}
            chip={chip}
            onPick={(type) => {
              setChip(type);
              changeInput(applyChip(detection.ambiguity.handle, type));
            }}
          />
        )}
        {detection.kind === "resolved" && (
          <ConfirmationCard detection={detection} busy={create.isPending} />
        )}
        {create.isError && <InputProblem error={create.error} onRetry={analyse} />}
      </div>

      <div className="fgw-brand-section__actions">
        <Button
          type="button"
          variant="secondary"
          disabled={create.isPending}
          onClick={onDone}
        >
          {tw("common.cancel")}
        </Button>
      </div>
    </form>
  );
}
