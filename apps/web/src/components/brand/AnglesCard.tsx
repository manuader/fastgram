"use client";

import type { ContentAngle, GeneratedContentAngle } from "@fastgram/contracts";
import {
  ANGLE_DESCRIPTION_MAX,
  ANGLE_TARGET_AUDIENCE_MAX,
  ANGLE_TITLE_MAX,
} from "@fastgram/contracts";
import { Badge, Button, EmptyState, Input, Skeleton, Textarea } from "@fastgram/ui";
import { useEffect, useId, useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import {
  useAngles,
  useCreateAngle,
  useDeleteAngle,
  useGenerateAngle,
  useSaveAngleWeights,
  useUpdateAngle,
  weightsValid,
} from "@/lib/brand/intel";
import { useBlitzPreferences } from "@/lib/blitz/preferences";
import { tw } from "@/lib/i18n/t";

interface AngleDraft {
  readonly title: string;
  readonly description: string;
  readonly targetAudience: string;
}

function draftValid(d: AngleDraft): boolean {
  return (
    d.title.trim() !== "" &&
    d.description.trim() !== "" &&
    d.targetAudience.trim() !== "" &&
    d.title.length <= ANGLE_TITLE_MAX &&
    d.description.length <= ANGLE_DESCRIPTION_MAX &&
    d.targetAudience.length <= ANGLE_TARGET_AUDIENCE_MAX
  );
}

function AngleFields({
  draft,
  onChange,
  disabled,
}: {
  readonly draft: AngleDraft;
  readonly onChange: (next: AngleDraft) => void;
  readonly disabled: boolean;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={`${id}-t`} className="fgw-brand-field__label">
        {tw("brand.angles.fieldTitle")}
      </label>
      <Input
        id={`${id}-t`}
        value={draft.title}
        maxLength={ANGLE_TITLE_MAX}
        disabled={disabled}
        onChange={(e) => onChange({ ...draft, title: e.target.value })}
      />
      <label htmlFor={`${id}-d`} className="fgw-brand-field__label">
        {tw("brand.angles.fieldDescription")}
      </label>
      <Textarea
        id={`${id}-d`}
        rows={3}
        value={draft.description}
        maxLength={ANGLE_DESCRIPTION_MAX}
        disabled={disabled}
        onChange={(e) => onChange({ ...draft, description: e.target.value })}
      />
      <label htmlFor={`${id}-a`} className="fgw-brand-field__label">
        {tw("brand.angles.fieldAudience")}
      </label>
      <Input
        id={`${id}-a`}
        value={draft.targetAudience}
        maxLength={ANGLE_TARGET_AUDIENCE_MAX}
        disabled={disabled}
        onChange={(e) => onChange({ ...draft, targetAudience: e.target.value })}
      />
    </div>
  );
}

/** La sugerencia de `AI-005`: no se persiste hasta que el usuario la guarda. */
function Suggestion({
  generated,
  onDone,
}: {
  readonly generated: GeneratedContentAngle;
  readonly onDone: () => void;
}) {
  const [draft, setDraft] = useState<AngleDraft>(generated);
  const create = useCreateAngle();
  return (
    <div className="fgw-brand__quick-check flex flex-col gap-2">
      <p className="m-0 font-medium">{tw("brand.angles.suggestion")}</p>
      <AngleFields draft={draft} onChange={setDraft} disabled={create.isPending} />
      {create.isError && <ApiErrorState error={create.error} />}
      <div className="fgw-brand-section__actions">
        <Button
          size="sm"
          loading={create.isPending}
          disabled={!draftValid(draft) || create.isPending}
          onClick={() => {
            create.mutate(
              {
                title: draft.title.trim(),
                description: draft.description.trim(),
                targetAudience: draft.targetAudience.trim(),
                // AI-005: si la marca cambió entre generar y guardar, se rechaza.
                expectedBrandRevision: generated.brandRevision,
              },
              { onSuccess: onDone },
            );
          }}
        >
          {tw("brand.angles.saveSuggestion")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          disabled={create.isPending}
          onClick={onDone}
        >
          {tw("brand.angles.discard")}
        </Button>
      </div>
    </div>
  );
}

function AngleRow({
  angle,
  weight,
  onWeight,
}: {
  readonly angle: ContentAngle;
  readonly weight: number | undefined;
  readonly onWeight: (value: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<AngleDraft>(angle);
  const update = useUpdateAngle();
  const remove = useDeleteAngle();
  const weightId = useId();
  const busy = update.isPending || remove.isPending;

  return (
    <li className="fgw-brand-field" data-active={angle.isActive}>
      {editing ? (
        <>
          <AngleFields draft={draft} onChange={setDraft} disabled={busy} />
          {update.isError && <ApiErrorState error={update.error} />}
          <div className="fgw-brand-section__actions">
            <Button
              size="sm"
              loading={update.isPending}
              disabled={!draftValid(draft) || busy}
              onClick={() => {
                update.mutate(
                  {
                    id: angle._id,
                    body: {
                      title: draft.title.trim(),
                      description: draft.description.trim(),
                      targetAudience: draft.targetAudience.trim(),
                    },
                  },
                  { onSuccess: () => setEditing(false) },
                );
              }}
            >
              {tw("brand.save")}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => {
                setDraft(angle);
                setEditing(false);
              }}
            >
              {tw("brand.angles.cancel")}
            </Button>
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <span className="fgw-brand-field__label">{angle.title}</span>
            {!angle.isActive && (
              <Badge tone="neutral" size="sm">
                {tw("brand.angles.inactive")}
              </Badge>
            )}
          </div>
          <p className="fgw-brand-field__text m-0">{angle.description}</p>
          <p className="fgw-brand-field__hint m-0">
            {tw("brand.angles.audience", { audience: angle.targetAudience })}
          </p>
          {angle.isActive && weight !== undefined && (
            <div className="flex items-center gap-2">
              <label htmlFor={weightId} className="fgw-brand-field__hint">
                {tw("brand.angles.weight")}
              </label>
              <Input
                id={weightId}
                type="number"
                min={0}
                max={100}
                step={1}
                className="w-20"
                value={String(weight)}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  onWeight(Number.isFinite(n) ? Math.round(n) : 0);
                }}
              />
              <span className="fgw-brand-field__hint">%</span>
            </div>
          )}
          {update.isError && <ApiErrorState error={update.error} />}
          {remove.isError && <ApiErrorState error={remove.error} />}
          <div className="fgw-brand-section__actions">
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              onClick={() => setEditing(true)}
            >
              {tw("brand.edit")}
            </Button>
            {angle.isActive ? (
              <Button
                size="sm"
                variant="ghost"
                loading={remove.isPending}
                disabled={busy}
                onClick={() => {
                  remove.mutate(angle._id);
                }}
              >
                {tw("brand.angles.delete")}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                loading={update.isPending}
                disabled={busy}
                onClick={() => {
                  update.mutate({ id: angle._id, body: { isActive: true } });
                }}
              >
                {tw("brand.angles.restore")}
              </Button>
            )}
          </div>
        </>
      )}
    </li>
  );
}

/**
 * Content angles en `/brand` — `P2-ANGLE-005` (`AI-005`, `FR-056`) y la
 * semilla de `P1-BRAND-023`: el generador ancla la sugerencia en lo que mejor
 * rindió cuando hay métricas. Listar, generar (no persiste hasta Save), editar,
 * pesar (`angleWeights` de `/blitz/preferences`, suma 100) y borrar (soft
 * delete reversible, `FR-056`).
 *
 * Vive en Brand y no en Blitz Settings porque ésa es de otro agente este
 * sprint; los pesos son los mismos (`PATCH /blitz/preferences`).
 */
export function AnglesCard() {
  const baseId = useId();
  const angles = useAngles();
  const prefs = useBlitzPreferences();
  const generate = useGenerateAngle();
  const saveWeights = useSaveAngleWeights();
  const [suggestion, setSuggestion] = useState<GeneratedContentAngle | null>(null);
  const [weights, setWeights] = useState<Record<string, number>>({});

  const serverWeights = prefs.data?.angleWeights;
  useEffect(() => {
    if (serverWeights !== undefined) setWeights({ ...serverWeights });
  }, [serverWeights]);

  const list = angles.data ?? [];
  const active = list.filter((a) => a.isActive);
  const activeWeights = Object.fromEntries(
    active.map((a) => [a._id, weights[a._id] ?? 0]),
  );
  const weightsDirty =
    serverWeights !== undefined &&
    active.some((a) => (serverWeights[a._id] ?? 0) !== (weights[a._id] ?? 0));
  const sum = Object.values(activeWeights).reduce((x, y) => x + y, 0);

  let body;
  if (angles.isPending) {
    body = (
      <div aria-busy="true" className="flex flex-col gap-2">
        <Skeleton shape="text" width="50%" />
        <Skeleton shape="text" width="80%" />
      </div>
    );
  } else if (angles.isError) {
    body = (
      <ApiErrorState
        error={angles.error}
        onRetry={() => {
          void angles.refetch();
        }}
      />
    );
  } else if (list.length === 0 && suggestion === null) {
    body = (
      <EmptyState
        size="sm"
        title={tw("brand.angles.emptyTitle")}
        description={tw("brand.angles.emptyBody")}
      />
    );
  } else {
    body = (
      <ul className="flex flex-col gap-4 p-0" style={{ listStyle: "none" }}>
        {[...active, ...list.filter((a) => !a.isActive)].map((angle) => (
          <AngleRow
            key={`${angle._id}-${angle.updatedAt}`}
            angle={angle}
            weight={serverWeights === undefined ? undefined : (weights[angle._id] ?? 0)}
            onWeight={(value) => {
              setWeights((w) => ({ ...w, [angle._id]: value }));
              saveWeights.reset();
            }}
          />
        ))}
      </ul>
    );
  }

  return (
    <section className="fgw-brand-section" aria-labelledby={`${baseId}-title`}>
      <header className="fgw-brand-section__header">
        <h2 id={`${baseId}-title`} className="fgw-brand-section__title">
          {tw("brand.angles.title")}
        </h2>
        <Button
          size="sm"
          loading={generate.isPending}
          disabled={generate.isPending || suggestion !== null}
          onClick={() => {
            generate.mutate(undefined, { onSuccess: setSuggestion });
          }}
        >
          {tw(generate.isPending ? "brand.angles.generating" : "brand.angles.generate")}
        </Button>
      </header>
      <p className="fgw-brand__note">{tw("brand.angles.body")}</p>
      {generate.isError && (
        <ApiErrorState
          error={generate.error}
          onRetry={() => {
            generate.mutate(undefined, { onSuccess: setSuggestion });
          }}
        />
      )}
      {suggestion !== null && (
        <Suggestion
          generated={suggestion}
          onDone={() => {
            setSuggestion(null);
            generate.reset();
          }}
        />
      )}
      {body}
      {weightsDirty && (
        <div className="flex flex-col gap-2">
          {!weightsValid(activeWeights) && (
            <p className="fgw-brand-field__error" role="alert">
              {tw("brand.angles.weightsSum", { sum })}
            </p>
          )}
          {saveWeights.isError && <ApiErrorState error={saveWeights.error} />}
          <div className="fgw-brand-section__actions">
            <Button
              size="sm"
              loading={saveWeights.isPending}
              disabled={!weightsValid(activeWeights) || saveWeights.isPending}
              onClick={() => {
                saveWeights.mutate(activeWeights);
              }}
            >
              {tw("brand.angles.saveWeights")}
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
