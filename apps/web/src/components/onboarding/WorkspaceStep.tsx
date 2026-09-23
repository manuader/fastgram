"use client";

import { Button, Input } from "@fastgram/ui";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { REMEDY_LABEL_KEY } from "@/lib/api/error-presentation";
import { tw } from "@/lib/i18n/t";
import {
  presentWorkspaceError,
  useCreateWorkspace,
  workspaceBodyOf,
  type WorkspaceField,
  type WorkspaceProblem,
} from "@/lib/onboarding/workspace";

export interface WorkspaceStepProps {
  /**
   * El workspace existe (`201`, o el `409` de "ya existe"). Quien monta el paso
   * pasa al flujo del workspace; ver `OnboardingEntry`.
   */
  readonly onReady: () => void;
}

/**
 * El paso que crea el workspace · `FR-010`, PRD §15.4, `P1-TENANT-001`.
 *
 * Sólo aparece si la sesión **no** tiene workspace. Pide lo que la API pide:
 * `Company Name` (obligatorio) y `Company Website` (opcional por `EXT-001`: una
 * marca que sólo vive en Instagram tiene que poder pasar sin inventar una web).
 *
 * ## Estados
 *
 * · **idle** — los dos campos con su `<label>` de verdad.
 * · **creando** — el botón con `loading` y el formulario `aria-busy`. Un segundo
 *   envío mientras corre no sale (`if (create.isPending) return`).
 * · **error de campo** — `400` con `details.field` o el `409` de web ya
 *   registrada: el texto va **debajo de ese campo**, con `id` propio, enlazado
 *   por `aria-describedby`, el campo con `aria-invalid`, y el foco se mueve a
 *   él. `role="alert"` lo anuncia sin esperar a que el lector llegue.
 * · **error de formulario** — lo que no es de un campo (red, `503`, `401`): sobre
 *   el botón, con `Try again` si reintentar puede servir.
 * · **ya existe** — no es un estado de esta pantalla: la mutación lo resuelve
 *   como éxito y se llama a `onReady` igual que tras un `201`.
 *
 * Validación **sólo del servidor**: la regla de los 2 caracteres y el detector
 * de webs viven en `packages/core`, y `apps/web` no los importa (ver la
 * cabecera de `lib/onboarding/brand-source.ts`). Una copia acá sería la
 * segunda definición de "URL válida".
 */
export function WorkspaceStep({ onReady }: WorkspaceStepProps) {
  const id = useId();
  const ids = {
    title: `${id}-title`,
    name: `${id}-name`,
    nameError: `${id}-name-error`,
    website: `${id}-website`,
    websiteHint: `${id}-website-hint`,
    websiteError: `${id}-website-error`,
  };
  const nameRef = useRef<HTMLInputElement>(null);
  const websiteRef = useRef<HTMLInputElement>(null);

  const [name, setName] = useState("");
  const [website, setWebsite] = useState("");
  const [problem, setProblem] = useState<WorkspaceProblem | null>(null);
  const create = useCreateWorkspace();

  // El foco va al campo que hay que corregir. En un efecto y no en el
  // `onError`: hasta el render siguiente el `aria-invalid` no está puesto.
  useEffect(() => {
    if (problem?.kind !== "field") return;
    (problem.field === "name" ? nameRef : websiteRef).current?.focus();
  }, [problem]);

  function send() {
    if (create.isPending) return;
    setProblem(null);
    create.mutate(workspaceBodyOf(name, website), {
      onSuccess: () => {
        onReady();
      },
      onError: (error) => {
        setProblem(presentWorkspaceError(error));
      },
    });
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    send();
  }

  /** Editar un campo retira **su** error; uno de formulario se va con cualquier edición. */
  function edited(field: WorkspaceField) {
    if (problem === null) return;
    if (problem.kind === "form" || problem.field === field) setProblem(null);
  }

  const fieldError = (field: WorkspaceField) =>
    problem?.kind === "field" && problem.field === field ? problem : null;
  const nameError = fieldError("name");
  const websiteError = fieldError("websiteUrl");
  const busy = create.isPending;

  return (
    <section className="fgw-onb" aria-labelledby={ids.title}>
      <header className="fgw-onb__header">
        <h1 id={ids.title} className="fgw-onb__title">
          {tw("onboarding.workspace.title")}
        </h1>
        <p className="fgw-onb__subtitle">{tw("onboarding.workspace.subtitle")}</p>
      </header>

      <form
        className="fgw-onb__form"
        onSubmit={submit}
        noValidate
        aria-busy={busy || undefined}
      >
        <div className="fgw-onb__field">
          <label htmlFor={ids.name} className="fgw-onb__label">
            {tw("onboarding.workspace.nameLabel")}
          </label>
          <Input
            ref={nameRef}
            id={ids.name}
            type="text"
            name="name"
            autoComplete="organization"
            required
            aria-required="true"
            value={name}
            invalid={nameError !== null}
            {...(nameError === null ? {} : { "aria-describedby": ids.nameError })}
            onChange={(event) => {
              setName(event.target.value);
              edited("name");
            }}
          />
          {nameError !== null && (
            <p id={ids.nameError} className="fgw-onb__field-error" role="alert">
              {tw(nameError.titleKey)}
            </p>
          )}
        </div>

        <div className="fgw-onb__field">
          <label htmlFor={ids.website} className="fgw-onb__label">
            {tw("onboarding.workspace.websiteLabel")}
          </label>
          <Input
            ref={websiteRef}
            id={ids.website}
            type="text"
            name="websiteUrl"
            inputMode="url"
            autoComplete="url"
            spellCheck={false}
            autoCapitalize="none"
            value={website}
            invalid={websiteError !== null}
            aria-describedby={
              websiteError === null
                ? ids.websiteHint
                : `${ids.websiteError} ${ids.websiteHint}`
            }
            onChange={(event) => {
              setWebsite(event.target.value);
              edited("websiteUrl");
            }}
          />
          {websiteError !== null && (
            <p id={ids.websiteError} className="fgw-onb__field-error" role="alert">
              {tw(websiteError.titleKey)}
            </p>
          )}
          <p id={ids.websiteHint} className="fgw-onb__hint">
            {tw("onboarding.workspace.websiteHint")}
          </p>
        </div>

        {problem?.kind === "form" && (
          <div className="fgw-onb__problem" role="alert">
            <p>{tw(problem.titleKey)}</p>
            {problem.remedy === "retry" && REMEDY_LABEL_KEY.retry !== null && (
              <Button type="button" variant="secondary" size="sm" onClick={send}>
                {tw(REMEDY_LABEL_KEY.retry)}
              </Button>
            )}
          </div>
        )}

        <div className="fgw-onb__actions">
          <Button type="submit" loading={busy} disabled={busy}>
            {tw(busy ? "onboarding.workspace.creating" : "onboarding.workspace.submit")}
          </Button>
        </div>
      </form>
    </section>
  );
}
