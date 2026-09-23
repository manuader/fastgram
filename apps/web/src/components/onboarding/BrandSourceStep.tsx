"use client";

import { MAX_BRAND_SOURCES_PER_WORKSPACE, type BrandSource } from "@fastgram/contracts";
import { Avatar, Button, Input } from "@fastgram/ui";
import { useId, useState, type FormEvent } from "react";
import { tw } from "@/lib/i18n/t";
import { SOURCE_TYPE_COPY, sourceLabel } from "@/lib/brand/source-types";
import {
  applyChip,
  CHIP_TYPES,
  createBodyOf,
  presentSourceInputError,
  useBrandSourceDetection,
  useCreateBrandSource,
  type Ambiguity,
  type ChipType,
  type Detection,
} from "@/lib/onboarding/brand-source";
import { SourceAnalysisList } from "./SourceAnalysisList";

function isChip(value: string): value is ChipType {
  return (CHIP_TYPES as readonly string[]).includes(value);
}

/** Un fallo de entrada o de alta, con la salida que le toca (§19). */
function InputProblem({
  error,
  onRetry,
}: {
  readonly error: unknown;
  readonly onRetry?: (() => void) | undefined;
}) {
  const { titleKey, titleVars, remedy } = presentSourceInputError(error);
  return (
    <div className="fgw-onb__problem" role="alert">
      <p>{tw(titleKey, titleVars)}</p>
      {remedy === "retry" && onRetry !== undefined && (
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {tw("common.tryAgain")}
        </Button>
      )}
    </div>
  );
}

/**
 * `ERR-B03` — el desambiguador de `FR-011.1`: un `@handle` sin dominio no es un
 * error, es una pregunta. Preselecciona la plataforma que el usuario ya tenga
 * conectada (la manda la API), o la del chip que ya fijó.
 */
function Disambiguator({
  ambiguity,
  chip,
  onPick,
}: {
  readonly ambiguity: Ambiguity;
  readonly chip: ChipType | null;
  readonly onPick: (type: ChipType) => void;
}) {
  const options = ambiguity.candidates.filter(isChip);
  const preselected =
    chip !== null && options.includes(chip) ? chip : ambiguity.preselected;
  return (
    <fieldset className="fgw-onb__ambiguous">
      <legend>
        {tw("error.brand.whichPlatform.title", { handle: ambiguity.handle })}
      </legend>
      <div className="fgw-onb__chips">
        {options.map((type) => (
          <Button
            key={type}
            type="button"
            size="sm"
            variant={type === preselected ? "primary" : "secondary"}
            aria-pressed={type === preselected}
            onClick={() => {
              onPick(type);
            }}
          >
            {tw(SOURCE_TYPE_COPY[type])}
          </Button>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * La tarjeta de confirmación de `FR-011.2`: *"favicon/avatar, el nombre
 * resuelto y el handle, más el botón primario `Analyse`"*.
 *
 * `displayName` y `avatarUrl` llegan **siempre `null`** hoy: `/resolve` no
 * tiene `SocialReader` montado y no los inventa. La tarjeta no espera a que
 * lleguen: nombre = el handle, avatar = sus iniciales.
 */
function ConfirmationCard({
  detection,
  busy,
}: {
  readonly detection: Extract<Detection, { kind: "resolved" }>;
  readonly busy: boolean;
}) {
  const { result, sourceType } = detection;
  const handle = sourceLabel(sourceType, result.handle);
  const name = result.displayName ?? handle;
  return (
    <div className="fgw-onb__card">
      <div className="fgw-onb__card-head">
        <Avatar
          size="md"
          name={name}
          {...(result.avatarUrl === null ? {} : { src: result.avatarUrl })}
        />
        <div className="fgw-onb__card-id">
          <p className="fgw-onb__card-name">{name}</p>
          <p className="fgw-onb__card-meta">
            {tw(SOURCE_TYPE_COPY[sourceType])}
            {result.displayName !== null && handle !== "" ? ` · ${handle}` : ""}
          </p>
        </div>
      </div>
      {result.resolvedFromPost === true && result.handle !== null && (
        // ERR-B12 — aviso, no error: no bloquea `Analyse`.
        <p className="fgw-onb__hint">
          {tw("error.brand.wholeProfile.title", { handle: result.handle })}
        </p>
      )}
      {result.available ? (
        <Button type="submit" loading={busy} disabled={busy}>
          {tw(busy ? "onboarding.source.analysing" : "onboarding.source.analyse")}
        </Button>
      ) : (
        <p className="fgw-onb__hint">{tw("onboarding.source.alreadyAdded")}</p>
      )}
    </div>
  );
}

export interface BrandSourceStepProps {
  /** Las fuentes que ya tiene el workspace (de `GET /onboarding`). */
  readonly sources: readonly BrandSource[];
  /** Salir del paso. Sólo se llama con al menos una fuente. */
  readonly onContinue: () => void;
}

/**
 * Paso 1 del onboarding · `FR-011.2` (PRD:826-833), `FR-010`. `P1-ONB-002`.
 *
 * Toda la lógica —chips, detección, alta con `Idempotency-Key`— está en
 * `lib/onboarding/brand-source.ts`. Acá se decide qué se ve:
 *
 * · **`idle`** — el input vacío con su placeholder literal y los seis chips.
 * · **`detecting`** — `Checking…` mientras corre `/resolve` (o su debounce).
 * · **`resolved`** — la tarjeta con `Analyse`, o el aviso de que ya está.
 * · **desambiguador** — `Which platform is @x on?` con las cinco.
 * · **error** — el `ERR-B` o el literal SSRF, con su salida.
 *
 * Tras `Analyse` (202) la fuente aparece arriba, en `pending`, con el estado
 * de su análisis; el input se pliega y quedan `Add another source` (hasta 5,
 * `FR-011.6`) y `Continue`.
 *
 * ## Lo que falta, a propósito
 *
 * **`Use description instead` no está.** `FR-011.2` lo conserva de Fastlane y
 * no tiene por dónde ir: `POST /brand/sources` rechaza `manual` y no hay
 * endpoint de onboarding para la rama (cabecera de `onboarding.ts`, `baseRecord`).
 * Un enlace que no puede terminar es peor que ninguno.
 */
export function BrandSourceStep({ sources, onContinue }: BrandSourceStepProps) {
  const inputId = useId();
  const feedbackId = useId();
  const [input, setInput] = useState("");
  const [chip, setChip] = useState<ChipType | null>(null);
  const [adding, setAdding] = useState(sources.length === 0);
  const [missingSource, setMissingSource] = useState(false);

  const detection = useBrandSourceDetection(input, chip);
  const create = useCreateBrandSource();

  const atCap = sources.length >= MAX_BRAND_SOURCES_PER_WORKSPACE;
  const showForm = (adding || sources.length === 0) && !atCap;

  function changeInput(next: string) {
    setInput(next);
    setMissingSource(false);
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
      onSuccess: () => {
        setInput("");
        setChip(null);
        setAdding(false);
      },
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (input.trim() === "") {
      // ERR-B01 — "campo vacío y sin rama manual" (FR-011.9).
      setMissingSource(true);
      return;
    }
    analyse();
  }

  function continueStep() {
    if (sources.length === 0) {
      setMissingSource(true);
      return;
    }
    onContinue();
  }

  return (
    <section className="fgw-onb" aria-labelledby={`${inputId}-title`}>
      <header className="fgw-onb__header">
        <h1 id={`${inputId}-title`} className="fgw-onb__title">
          {tw("onboarding.source.title")}
        </h1>
        <p className="fgw-onb__subtitle">{tw("onboarding.source.subtitle")}</p>
      </header>

      {sources.length > 0 && (
        <div className="fgw-onb__added">
          <h2 className="fgw-onb__subheading">{tw("onboarding.source.added")}</h2>
          <SourceAnalysisList sources={sources} />
        </div>
      )}

      {atCap && <p className="fgw-onb__hint">{tw("error.brand.sourceLimit.title")}</p>}

      {showForm && (
        <form className="fgw-onb__form" onSubmit={submit} noValidate>
          <label htmlFor={inputId} className="fg-visually-hidden">
            {tw("onboarding.source.inputLabel")}
          </label>
          <Input
            id={inputId}
            type="text"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            autoCapitalize="none"
            value={input}
            placeholder={tw("onboarding.source.placeholder")}
            invalid={missingSource || detection.kind === "error"}
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
            {missingSource && (
              <p className="fgw-onb__problem" role="alert">
                {tw("error.brand.sourceRequired.title")}
              </p>
            )}
            {!missingSource && detection.kind === "detecting" && (
              <p className="fgw-onb__hint">{tw("onboarding.source.detecting")}</p>
            )}
            {!missingSource && detection.kind === "error" && (
              <InputProblem error={detection.error} />
            )}
            {!missingSource && detection.kind === "ambiguous" && (
              <Disambiguator
                ambiguity={detection.ambiguity}
                chip={chip}
                onPick={(type) => {
                  setChip(type);
                  changeInput(applyChip(detection.ambiguity.handle, type));
                }}
              />
            )}
            {!missingSource && detection.kind === "resolved" && (
              // `Analyse` es el `submit` del formulario: Enter en el input
              // hace lo mismo que el botón.
              <ConfirmationCard detection={detection} busy={create.isPending} />
            )}
            {create.isError && <InputProblem error={create.error} onRetry={analyse} />}
          </div>
        </form>
      )}

      <div className="fgw-onb__actions">
        {!showForm && !atCap && (
          <Button
            variant="link"
            onClick={() => {
              setAdding(true);
            }}
          >
            {tw("onboarding.source.addAnother")}
          </Button>
        )}
        {/* Siempre visible: pulsarlo sin fuentes es la condición exacta de
            ERR-B01 ("campo vacío y sin rama manual", FR-011.9). */}
        <Button variant="secondary" onClick={continueStep}>
          {tw("onboarding.source.continue")}
        </Button>
      </div>
    </section>
  );
}
