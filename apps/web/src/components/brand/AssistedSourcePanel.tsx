"use client";

import type { BrandSource } from "@fastgram/contracts";
import { Button, Spinner, Textarea } from "@fastgram/ui";
import { useId, useState, type FormEvent } from "react";
import { presentError } from "@/lib/api/error-presentation";
import {
  ASSIST_MAX_CAPTIONS,
  ASSIST_TEXT_MAX,
  assistRequestFrom,
  useAssistSource,
  type AssistDraftProblem,
} from "@/lib/brand/assist";
import { tw, type CopyKey, type MessageVars } from "@/lib/i18n/t";

function problemCopy(problem: AssistDraftProblem): { key: CopyKey; vars?: MessageVars } {
  switch (problem.kind) {
    case "empty":
      return { key: "brand.assist.empty" };
    case "bioTooLong":
      return { key: "brand.assist.bioTooLong", vars: { max: problem.max } };
    case "captionTooLong":
      return {
        key: "brand.assist.captionTooLong",
        vars: { max: problem.max, index: problem.index },
      };
    case "tooManyCaptions":
      return {
        key: "brand.assist.tooManyCaptions",
        vars: { max: problem.max, count: problem.count },
      };
  }
}

/**
 * El panel del tier D asistido · `P1-BRAND-014`, `FR-011.4` (fila D).
 *
 * Aparece debajo de una fuente social que no se pudo leer (ver `canAssist`).
 * Dos campos —bio y captions— y un envío. Estados:
 *  - **idle**: el formulario;
 *  - **inválido** (antes de mandar): se dice qué falta o qué sobra, sin `POST`;
 *  - **enviando**: botón deshabilitado con spinner y `aria-busy`;
 *  - **error**: lo que dijo la API, sin `Try again` automático (ver
 *    `lib/brand/assist.ts`: el listado se relee y muestra el estado real);
 *  - **enviado**: la fuente pasa a `analyzing` y esta fila deja de ofrecer el
 *    panel; se anuncia por `role="status"`.
 *
 * Lo que se pega es **dato, nunca instrucción**: la pantalla no lo interpreta;
 * el worker lo contiene igual que una bio leída.
 */
export function AssistedSourcePanel({ source }: { readonly source: BrandSource }) {
  const baseId = useId();
  const bioId = `${baseId}-bio`;
  const captionsId = `${baseId}-captions`;
  const hintId = `${baseId}-hint`;
  const problemId = `${baseId}-problem`;
  const [bio, setBio] = useState("");
  const [captions, setCaptions] = useState("");
  const [problem, setProblem] = useState<AssistDraftProblem | null>(null);
  const assist = useAssistSource();

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const request = assistRequestFrom(bio, captions);
    if (!request.ok) {
      setProblem(request.problem);
      return;
    }
    setProblem(null);
    assist.mutate({ id: source._id, body: request.body });
  }

  const pending = assist.isPending;
  const shownProblem = problem === null ? null : problemCopy(problem);
  const apiProblem = assist.isError ? presentError(assist.error) : null;

  return (
    <form
      className="fgw-brand-source__stale"
      aria-labelledby={`${baseId}-title`}
      aria-busy={pending}
      onSubmit={submit}
      noValidate
    >
      <p id={`${baseId}-title`}>
        <strong>{tw("brand.assist.title")}</strong>
      </p>
      <p>{tw("brand.assist.body")}</p>

      <div className="fgw-brand-field">
        <label htmlFor={bioId} className="fgw-brand-field__label">
          {tw("brand.assist.bio")}
        </label>
        <Textarea
          id={bioId}
          value={bio}
          rows={3}
          disabled={pending}
          invalid={problem?.kind === "bioTooLong" || problem?.kind === "empty"}
          aria-describedby={problem === null ? undefined : problemId}
          onChange={(e) => {
            setBio(e.target.value);
          }}
        />
        <p className="fgw-brand-field__hint">
          <span className="fgw-brand-field__counter">
            {tw("brand.field.counter", {
              count: bio.trim().length,
              max: ASSIST_TEXT_MAX,
            })}
          </span>
        </p>
      </div>

      <div className="fgw-brand-field">
        <label htmlFor={captionsId} className="fgw-brand-field__label">
          {tw("brand.assist.captions")}
        </label>
        <Textarea
          id={captionsId}
          value={captions}
          rows={5}
          disabled={pending}
          invalid={problem !== null && problem.kind !== "bioTooLong"}
          aria-describedby={problem === null ? hintId : `${hintId} ${problemId}`}
          onChange={(e) => {
            setCaptions(e.target.value);
          }}
        />
        <p id={hintId} className="fgw-brand-field__hint">
          {tw("brand.assist.captionsHint", { max: ASSIST_MAX_CAPTIONS })}
        </p>
      </div>

      {shownProblem !== null && (
        <p id={problemId} className="fgw-brand-field__error" role="alert">
          {tw(shownProblem.key, shownProblem.vars)}
        </p>
      )}
      {apiProblem !== null && (
        <div className="fgw-brand-source__problem" role="alert">
          <p>{tw(apiProblem.titleKey, apiProblem.titleVars)}</p>
          {apiProblem.descriptionKey !== undefined && (
            <p>{tw(apiProblem.descriptionKey, apiProblem.vars)}</p>
          )}
        </div>
      )}

      <Button type="submit" variant="secondary" size="sm" disabled={pending}>
        {pending && <Spinner size="sm" aria-hidden="true" />}
        {tw(pending ? "brand.assist.submitting" : "brand.assist.submit")}
      </Button>
      {assist.isSuccess && (
        <p className="fg-visually-hidden" role="status">
          {tw("brand.assist.sent")}
        </p>
      )}
    </form>
  );
}
