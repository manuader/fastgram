"use client";

import type { BrandSource, CompanyProfile } from "@fastgram/contracts";
import { Button, Textarea } from "@fastgram/ui";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { presentError } from "@/lib/api/error-presentation";
import { tw } from "@/lib/i18n/t";
import {
  buildProfilePatch,
  FIELD_LABEL,
  isTooLong,
  PROFILE_FIELD_MAX,
  isRevisionConflict,
  revisionMovedDuring,
  toDraft,
  useSaveBrandProfile,
  type ProfileDraft,
  type ProfileField,
  type ProfileSection as Section,
} from "@/lib/brand/profile";
import { FieldProvenance } from "./FieldProvenance";

function displayValue(profile: CompanyProfile, field: ProfileField): string {
  if (field === "businessCategories")
    return (profile.businessCategories ?? []).join(", ");
  if (field === "toneOfVoice") return profile.toneOfVoice ?? "";
  if (field === "targetAudience") return profile.targetAudience ?? "";
  return profile[field];
}

/**
 * El formulario de una sección abierta.
 *
 * Se monta al pulsar `Edit` y se desmonta al salir, así que la línea base
 * —contra la que {@link buildProfilePatch} decide qué cambió— es el perfil **en
 * el momento de abrir**, y no se re-siembra con los refetch del polling: eso
 * pisaría lo que el usuario está escribiendo.
 */
function SectionEditor({
  section,
  profile,
  onClose,
  onSaved,
  onReload,
}: {
  readonly section: Section;
  readonly profile: CompanyProfile;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly onReload: () => void;
}) {
  const baseId = useId();
  const [baseline] = useState<ProfileDraft>(() => toDraft(profile));
  const [startRevision] = useState(profile.brandRevision);
  const [draft, setDraft] = useState<ProfileDraft>(baseline);
  const save = useSaveBrandProfile();
  const firstField = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    firstField.current?.focus();
  }, []);

  const tooLong = section.fields.filter((f) => isTooLong(draft[f]));
  const moved = revisionMovedDuring(startRevision, profile);

  function submit(event?: FormEvent<HTMLFormElement>) {
    event?.preventDefault();
    if (tooLong.length > 0 || save.isPending) return;
    const patch = buildProfilePatch(baseline, draft, section.fields);
    if (patch === null) {
      // Nada cambió: un `PATCH` sólo subiría `brandRevision` y marcaría campos
      // como editados sin que nadie los tocara.
      onClose();
      return;
    }
    // `P1-BRANDPG-004`: la revisión con la que se abrió la sección. Si otra
    // pestaña guardó antes, la API responde 409 en vez de pisar.
    save.mutate(
      { ...patch, expectedBrandRevision: startRevision },
      { onSuccess: onSaved },
    );
  }

  const conflict = save.isError && isRevisionConflict(save.error);

  const errorRemedy = save.isError ? presentError(save.error).remedy : null;

  return (
    <form className="fgw-brand-section__form" onSubmit={submit} noValidate>
      {moved && (
        <p className="fgw-brand__notice" role="status">
          {tw("brand.revisionMoved")}
        </p>
      )}
      {section.fields.map((field, index) => {
        const id = `${baseId}-${field}`;
        const hintId = `${id}-hint`;
        const invalid = isTooLong(draft[field]);
        return (
          <div key={field} className="fgw-brand-field">
            <label htmlFor={id} className="fgw-brand-field__label">
              {tw(FIELD_LABEL[field])}
            </label>
            <Textarea
              id={id}
              ref={index === 0 ? firstField : undefined}
              value={draft[field]}
              rows={field === "businessCategories" ? 2 : 4}
              invalid={invalid}
              aria-describedby={hintId}
              onChange={(e) => {
                const value = e.target.value;
                setDraft((current) => ({ ...current, [field]: value }));
              }}
            />
            <p id={hintId} className="fgw-brand-field__hint">
              {field === "businessCategories" && (
                <span>{tw("brand.field.categoriesHint")} </span>
              )}
              {invalid ? (
                <span className="fgw-brand-field__error">
                  {tw("brand.field.tooLong", { max: PROFILE_FIELD_MAX })}
                </span>
              ) : null}
              <span className="fgw-brand-field__counter">
                {tw("brand.field.counter", {
                  count: draft[field].length,
                  max: PROFILE_FIELD_MAX,
                })}
              </span>
            </p>
          </div>
        );
      })}

      {conflict && (
        <div className="fgw-brand__notice" role="alert">
          <p>{tw("brand.revisionConflict")}</p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => {
              // Se cierra la sección: reabrirla parte de la revisión nueva.
              save.reset();
              onReload();
              onClose();
            }}
          >
            {tw("brand.reload")}
          </Button>
        </div>
      )}
      {save.isError && !conflict && (
        <ApiErrorState
          error={save.error}
          // `Reload` (un `409`) relee el perfil; `Try again` vuelve a mandar el
          // mismo patch. Reenviar un patch viejo como respuesta a "esto
          // cambió" sería exactamente lo que el `409` quiere evitar.
          onRetry={
            errorRemedy === "reload"
              ? () => {
                  save.reset();
                  onReload();
                }
              : () => {
                  submit();
                }
          }
        />
      )}

      <div className="fgw-brand-section__actions">
        <Button
          type="submit"
          loading={save.isPending}
          disabled={tooLong.length > 0 || save.isPending}
        >
          {tw(save.isPending ? "brand.saving" : "brand.save")}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={save.isPending}
          onClick={onClose}
        >
          {tw("common.cancel")}
        </Button>
      </div>
    </form>
  );
}

export interface ProfileSectionProps {
  readonly section: Section;
  readonly profile: CompanyProfile;
  readonly sources: readonly BrandSource[] | undefined;
  readonly editing: boolean;
  /** `false` mientras otra sección está abierta: una sola a la vez. */
  readonly canEdit: boolean;
  readonly justSaved: boolean;
  readonly onEdit: () => void;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly onReload: () => void;
}

/**
 * Una sección del Company Profile · `FR-020` (`P1-BRANDPG-001`, `-003`).
 *
 * Lectura con los badges de `F-025` debajo de cada campo; `Edit` abre el
 * formulario de la sección y sólo de ella.
 *
 * Una sección a la vez, y no por comodidad: el aviso de "el perfil cambió
 * mientras editabas" compara revisiones, y guardar otra sección desde esta
 * misma pantalla movería la revisión y dispararía el aviso por un cambio propio.
 */
export function ProfileSection({
  section,
  profile,
  sources,
  editing,
  canEdit,
  justSaved,
  onEdit,
  onClose,
  onSaved,
  onReload,
}: ProfileSectionProps) {
  const headingId = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(editing);

  // Al cerrar el formulario, el foco vuelve al `Edit` que lo abrió: si no, se
  // pierde en el `<body>` cuando el formulario se desmonta.
  useEffect(() => {
    if (wasEditing.current && !editing) editButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  const title = tw(section.titleKey);

  return (
    <section className="fgw-brand-section" aria-labelledby={headingId}>
      <header className="fgw-brand-section__header">
        <h2 id={headingId} className="fgw-brand-section__title">
          {title}
        </h2>
        {justSaved && !editing && (
          <p className="fgw-brand-section__saved" role="status">
            <span aria-hidden="true">✓ </span>
            {tw("brand.saved")}
          </p>
        )}
        {!editing && (
          <Button
            ref={editButton}
            variant="secondary"
            size="sm"
            disabled={!canEdit}
            aria-label={tw("brand.editSection", { section: title })}
            onClick={onEdit}
          >
            {tw("brand.edit")}
          </Button>
        )}
      </header>

      {editing ? (
        <SectionEditor
          section={section}
          profile={profile}
          onClose={onClose}
          onSaved={onSaved}
          onReload={onReload}
        />
      ) : (
        <dl className="fgw-brand-section__fields">
          {section.fields.map((field) => {
            const value = displayValue(profile, field);
            return (
              <div key={field} className="fgw-brand-field" data-field={field}>
                <dt className="fgw-brand-field__label">{tw(FIELD_LABEL[field])}</dt>
                <dd className="fgw-brand-field__value">
                  {value === "" ? (
                    <span className="fgw-brand-field__empty">
                      {tw("brand.field.empty")}
                    </span>
                  ) : (
                    <p className="fgw-brand-field__text">{value}</p>
                  )}
                  <FieldProvenance meta={profile.fieldMeta[field]} sources={sources} />
                </dd>
              </div>
            );
          })}
        </dl>
      )}
    </section>
  );
}
