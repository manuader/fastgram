"use client";

import type { StudioFormat } from "@fastgram/contracts";
import { Button, Card, Checkbox, Select, Textarea, cn } from "@fastgram/ui";
import { useRouter } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { editorHref } from "@/components/editor/ContentEditor";
import { presentError } from "@/lib/api/error-presentation";
import { TEXT_STYLE_COPY } from "@/lib/blitz/preferences";
import { tw, type CopyKey } from "@/lib/i18n/t";
import {
  SLIDESHOW_MAX_SLIDES,
  STUDIO_AI_PROMPT_MAX,
  STUDIO_ASPECT_RATIOS,
  STUDIO_SLOTS,
  STUDIO_STYLE_PRESETS,
  canGenerate,
  emptyDraft,
  newIdempotencyKey,
  studioSteps,
  toStudioRequest,
  useCreateStudioContent,
  withTextCount,
  type StudioDraft,
  type StudioPick,
  type StudioSlot,
  type StudioSlotKey,
  type StudioStepId,
} from "@/lib/studio/studio";
import { StudioMediaPicker } from "./StudioMediaPicker";
import { StudioPreview } from "./StudioPreview";

const SLOT_COPY: Readonly<Record<StudioSlotKey, CopyKey>> = {
  slides: "studio.slot.slides",
  video: "studio.slot.video",
  image: "studio.slot.image",
  hookVideo: "studio.slot.hookVideo",
  demoVideo: "studio.slot.demoVideo",
};

const GREEN_SCREEN_VIDEO_COPY: CopyKey = "studio.slot.greenScreenVideo";

const STEP_COPY: Readonly<Record<StudioStepId, CopyKey>> = {
  media: "studio.step.media",
  text: "studio.step.text",
  style: "studio.step.style",
};

function slotLabel(format: StudioFormat, slot: StudioSlot): string {
  if (format === "green-screen" && slot.key === "video")
    return tw(GREEN_SCREEN_VIDEO_COPY);
  if (format === "wall-of-text" && slot.key === "video")
    return tw("studio.slot.backgroundVideo");
  return tw(SLOT_COPY[slot.key]);
}

/**
 * «Create New» del Content Studio (`F-072`, `F-073`, `F-078`, `F-079`,
 * `F-081`/`F-082`: Save y Clear).
 *
 * Tres pasos con check —media, texto, estilo— y `Save` deshabilitado hasta
 * que los tres están completos (`F-073`). `Save` crea la pieza con
 * `POST /content/studio` (el servidor arma el payload con la geometría de
 * Blitz) y abre el editor, donde se ajusta todo lo demás (posición, audio,
 * swaps). `Schedule` no está acá: se programa desde el editor o la Library.
 *
 * El texto se escribe o lo escribe la IA (modelo de la tarea `text`) con un
 * brief; en ese caso el worker lo escribe antes del render, y si no hay modelo
 * la pieza falla con `llm_not_configured` (se ve en la Library).
 */
export function StudioCreate({ format }: { readonly format: StudioFormat }) {
  const router = useRouter();
  const [draft, setDraft] = useState<StudioDraft>(() => emptyDraft());
  const [picking, setPicking] = useState<StudioSlot | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey);
  const create = useCreateStudioContent();
  const steps = studioSteps(format, draft);
  const ready = canGenerate(format, draft);
  const ids = { prompt: useId(), style: useId(), ratio: useId() };

  const update = (patch: Partial<StudioDraft>) =>
    setDraft((d) => withTextCount(format, { ...d, ...patch }));

  const clear = () => {
    setDraft(emptyDraft());
    create.reset();
    setIdempotencyKey(newIdempotencyKey());
  };

  const save = () => {
    const body = toStudioRequest(format, draft);
    if (body === null) return;
    create.mutate(
      { body, idempotencyKey },
      {
        onSuccess: (content) => {
          router.push(editorHref(content._id));
        },
      },
    );
  };

  const picksOf = (slot: StudioSlot): StudioPick[] => {
    if (slot.key === "slides") return [...draft.slides];
    const one = draft[slot.key];
    return one === null ? [] : [one];
  };

  const error = create.isError ? presentError(create.error) : null;

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="flex flex-col gap-4">
        <ol className="flex flex-wrap gap-2" aria-label={tw("studio.steps")}>
          {steps.map((step, i) => (
            <li
              key={step.id}
              className={cn(
                "flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs",
                step.done ? "border-accent text-text" : "border-border text-text-muted",
              )}
            >
              <span aria-hidden>{step.done ? "✓" : String(i + 1)}</span>
              {tw(STEP_COPY[step.id])}
              <span className="sr-only">
                {tw(step.done ? "studio.step.done" : "studio.step.pending")}
              </span>
            </li>
          ))}
        </ol>

        <Section title={tw("studio.step.media")}>
          <div className="flex flex-col gap-3">
            {STUDIO_SLOTS[format].map((slot) => {
              const picks = picksOf(slot);
              return (
                <div key={slot.key} className="flex flex-col gap-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium">{slotLabel(format, slot)}</span>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => setPicking(slot)}
                    >
                      {tw(
                        picks.length === 0 ? "studio.slot.choose" : "studio.slot.change",
                      )}
                    </Button>
                  </div>
                  {picks.length === 0 ? (
                    <p className="text-xs text-text-muted">{tw("studio.slot.empty")}</p>
                  ) : (
                    <ul className="flex flex-wrap gap-2">
                      {picks.map((p, i) => (
                        <li
                          key={p.mediaId}
                          className="relative h-24 w-14 overflow-hidden rounded-md bg-surface-sunken"
                        >
                          {p.mediaType === "image" ? (
                            <img
                              src={p.url}
                              alt=""
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <video
                              src={p.url}
                              muted
                              playsInline
                              preload="metadata"
                              className="h-full w-full object-cover"
                            />
                          )}
                          {slot.multiple && (
                            <span className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[10px] text-white">
                              {String(i + 1)}
                            </span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                  {slot.key === "demoVideo" && (
                    <p className="text-xs text-text-muted">{tw("studio.demoGuide")}</p>
                  )}
                </div>
              );
            })}
          </div>
        </Section>

        <Section title={tw("studio.step.text")}>
          <div
            className="mb-3 flex gap-2"
            role="radiogroup"
            aria-label={tw("studio.text.mode")}
          >
            {(["write", "ai"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={draft.textMode === mode}
                className={cn(
                  "fg-focusable rounded-full border px-3 py-1 text-xs",
                  draft.textMode === mode
                    ? "border-accent bg-accent-subtle text-text"
                    : "border-border text-text-muted",
                )}
                onClick={() => update({ textMode: mode })}
              >
                {tw(mode === "write" ? "studio.text.write" : "studio.text.ai")}
              </button>
            ))}
          </div>

          {draft.textMode === "ai" ? (
            <div className="flex flex-col gap-2">
              <label htmlFor={ids.prompt} className="text-sm font-medium">
                {tw("studio.text.aiPrompt")}
              </label>
              <Textarea
                id={ids.prompt}
                value={draft.aiPrompt}
                maxLength={STUDIO_AI_PROMPT_MAX}
                placeholder={tw("studio.text.aiPlaceholder")}
                onChange={(e) => update({ aiPrompt: e.target.value })}
              />
              <Checkbox
                checked={draft.mentionBusiness}
                onChange={(e) => update({ mentionBusiness: e.target.checked })}
                label={tw("studio.text.mentionBusiness")}
              />
              <p className="text-xs text-text-muted">{tw("studio.text.aiHint")}</p>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {draft.texts.map((text, i) => (
                <label key={i} className="flex flex-col gap-1">
                  <span className="text-sm font-medium">
                    {format === "slideshow"
                      ? tw("studio.text.slide", { n: i + 1 })
                      : tw("studio.text.caption")}
                  </span>
                  <Textarea
                    value={text}
                    onChange={(e) => {
                      const texts = [...draft.texts];
                      texts[i] = e.target.value;
                      update({ texts });
                    }}
                  />
                </label>
              ))}
              {format === "slideshow" && (
                <p className="text-xs text-text-muted">
                  {tw("studio.text.slideHint", { max: SLIDESHOW_MAX_SLIDES })}
                </p>
              )}
            </div>
          )}
        </Section>

        <Section title={tw("studio.step.style")}>
          <div className="flex flex-wrap gap-4">
            <label htmlFor={ids.style} className="flex flex-col gap-1 text-sm">
              <span className="font-medium">{tw("studio.style.preset")}</span>
              <Select
                id={ids.style}
                value={draft.stylePresetId}
                onChange={(e) => update({ stylePresetId: e.target.value })}
                options={STUDIO_STYLE_PRESETS.map((id) => ({
                  value: id,
                  label: TEXT_STYLE_COPY[id] === undefined ? id : tw(TEXT_STYLE_COPY[id]),
                }))}
              />
            </label>
            {format === "slideshow" && (
              <label htmlFor={ids.ratio} className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{tw("studio.style.aspectRatio")}</span>
                <Select
                  id={ids.ratio}
                  value={draft.aspectRatio}
                  onChange={(e) => {
                    const next = STUDIO_ASPECT_RATIOS.find((r) => r === e.target.value);
                    if (next !== undefined) update({ aspectRatio: next });
                  }}
                  options={STUDIO_ASPECT_RATIOS.map((r) => ({ value: r, label: r }))}
                />
              </label>
            )}
          </div>
        </Section>

        {error !== null && (
          <p
            role="alert"
            className="rounded-md border border-danger px-3 py-2 text-sm text-danger"
          >
            {tw(error.titleKey, error.titleVars)}
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="ghost" onClick={clear} disabled={create.isPending}>
            {tw("studio.clear")}
          </Button>
          {/* ERR-L01 (PRD §19.2, literal): mientras se crea, el botón dice
              `Generating...` y una región viva `Generating your content...`. */}
          <Button onClick={save} disabled={!ready} loading={create.isPending}>
            {create.isPending ? tw("loading.studioGeneratingButton") : tw("studio.save")}
          </Button>
          <span role="status" className="text-xs text-text-muted">
            {create.isPending ? tw("loading.studioGenerating") : ""}
          </span>
          {!ready && (
            <span className="text-xs text-text-muted">
              {tw("studio.saveDisabledHint")}
            </span>
          )}
        </div>
      </div>

      <aside aria-label={tw("studio.preview")}>
        <StudioPreview format={format} draft={draft} />
      </aside>

      {picking !== null && (
        <StudioMediaPicker
          open
          type={picking.mediaType}
          title={slotLabel(format, picking)}
          preferred={picking.preferred}
          max={picking.multiple ? SLIDESHOW_MAX_SLIDES : 1}
          initial={picksOf(picking)}
          onCancel={() => setPicking(null)}
          onPick={(picks) => {
            const slot = picking;
            setPicking(null);
            if (slot.key === "slides") update({ slides: picks });
            else update({ [slot.key]: picks[0] ?? null } as Partial<StudioDraft>);
          }}
        />
      )}
    </div>
  );
}

function Section({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <Card padding="md">
      <h2 className="mb-3 text-sm font-semibold">{title}</h2>
      {children}
    </Card>
  );
}
