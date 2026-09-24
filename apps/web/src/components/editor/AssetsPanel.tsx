"use client";

import type { ContentAssets, ContentType, MediaElement } from "@fastgram/contracts";
import { REGENERATE_PROMPT_MAX } from "@fastgram/contracts";
import { Button, Textarea, cn } from "@fastgram/ui";
import { useId } from "react";
import { tw, type CopyKey } from "@/lib/i18n/t";
import type { MediaSlot } from "@/lib/editor/state";

export type SwapTarget =
  | { readonly kind: "slide"; readonly index: number }
  | { readonly kind: "slot"; readonly slot: MediaSlot }
  | { readonly kind: "audio" };

export interface AssetsPanelProps {
  readonly contentType: ContentType;
  readonly assets: ContentAssets;
  readonly baseAssets: ContentAssets;
  readonly slide: number;
  readonly onSwap: (target: SwapTarget) => void;
  readonly disabled?: boolean;
  readonly prompt: string;
  readonly onPromptChange: (prompt: string) => void;
  /** `null` = el usuario no eligió; no se manda (el contrato lo deja opcional). */
  readonly mentionBusiness: boolean | null;
  readonly onMentionChange: (value: boolean) => void;
  readonly onRegenerate: () => void;
  readonly regenerating: boolean;
  /** Por qué no se puede regenerar ahora, o `null`. */
  readonly regenerateBlockedBy: CopyKey | null;
}

const SLOT_COPY: Readonly<
  Record<MediaSlot, { readonly title: CopyKey; readonly subtitle: CopyKey }>
> = {
  image: { title: "editor.assets.image", subtitle: "editor.assets.background" },
  video: { title: "editor.assets.video", subtitle: "editor.assets.background" },
  hook_video: { title: "editor.assets.video", subtitle: "editor.assets.hookVideo" },
  demo_video: { title: "editor.assets.video", subtitle: "editor.assets.demoVideo" },
};

/**
 * El panel izquierdo `ASSETS` de FR-051: una fila por asset con miniatura,
 * etiqueta, subtítulo y `Swap`; `MENTION YOUR BUSINESS?`, `PROMPT` y
 * `Regenerate Text`.
 */
export function AssetsPanel(props: AssetsPanelProps) {
  const { contentType, assets, baseAssets, slide, onSwap, disabled = false } = props;
  const promptId = useId();

  const rows: {
    key: string;
    title: string;
    subtitle: string;
    media: MediaElement | null;
    kind: "image" | "video" | "audio";
    changed: boolean;
    target: SwapTarget;
  }[] = [];

  if (contentType === "slideshow") {
    const image = assets.slides?.[slide];
    if (image !== undefined) {
      rows.push({
        key: "slide",
        title: tw("editor.assets.imageSet"),
        subtitle: tw("editor.assets.slideImage", { n: slide + 1 }),
        media: image,
        kind: "image",
        changed: baseAssets.slides?.[slide]?.url !== image.url,
        target: { kind: "slide", index: slide },
      });
    }
  } else {
    for (const slot of ["image", "video", "hook_video", "demo_video"] as const) {
      const media = assets[slot];
      if (media === undefined) continue;
      const copy =
        contentType === "green-screen" && slot === "video"
          ? { title: "editor.assets.video", subtitle: "editor.assets.greenScreenVideo" }
          : SLOT_COPY[slot];
      rows.push({
        key: slot,
        title: tw(copy.title as CopyKey),
        subtitle: tw(copy.subtitle as CopyKey),
        media,
        kind: slot === "image" ? "image" : "video",
        changed: baseAssets[slot]?.url !== media.url,
        target: { kind: "slot", slot },
      });
    }
    if ("audio" in assets) {
      rows.push({
        key: "audio",
        title: tw("editor.assets.audio"),
        subtitle: tw(
          assets.audio === null || assets.audio === undefined
            ? "editor.assets.noAudio"
            : "editor.assets.audioTrack",
        ),
        media: null,
        kind: "audio",
        changed: (assets.audio?.url ?? null) !== (baseAssets.audio?.url ?? null),
        target: { kind: "audio" },
      });
    }
  }

  const tooLong = props.prompt.length > REGENERATE_PROMPT_MAX;

  return (
    <div className="grid gap-5">
      <section aria-labelledby={`${promptId}-assets`}>
        <h2
          id={`${promptId}-assets`}
          className="mb-2 text-xs font-semibold uppercase tracking-wide text-text-subtle"
        >
          {tw("editor.assets.title")}
        </h2>
        <ul className="grid gap-2">
          {rows.map((r) => (
            <li
              key={r.key}
              className="flex items-center gap-3 rounded-lg border border-border bg-surface p-2"
            >
              <Thumb media={r.media} kind={r.kind} />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{r.title}</p>
                <p className="truncate text-xs text-text-muted">{r.subtitle}</p>
                {r.changed && (
                  <p className="text-xs text-accent">{tw("editor.assets.changed")}</p>
                )}
              </div>
              <Button
                size="sm"
                variant="secondary"
                disabled={disabled}
                aria-label={`${tw("editor.assets.swap")} · ${r.subtitle}`}
                onClick={() => onSwap(r.target)}
              >
                {tw("editor.assets.swap")}
              </Button>
            </li>
          ))}
        </ul>
      </section>

      <section className="grid gap-2">
        <span
          id={`${promptId}-mention`}
          className="text-xs font-semibold uppercase tracking-wide text-text-subtle"
        >
          {tw("editor.mention.label")}
        </span>
        <div role="group" aria-labelledby={`${promptId}-mention`} className="flex gap-1">
          {([true, false] as const).map((v) => (
            <button
              key={String(v)}
              type="button"
              aria-pressed={props.mentionBusiness === v}
              className={cn(
                "fg-focusable flex-1 rounded-md border px-2 py-1 text-xs",
                props.mentionBusiness === v
                  ? "border-accent bg-accent-subtle text-text"
                  : "border-border text-text-muted hover:border-border-strong",
              )}
              onClick={() => props.onMentionChange(v)}
            >
              {tw(v ? "editor.mention.yes" : "editor.mention.no")}
            </button>
          ))}
        </div>
      </section>

      <section className="grid gap-2">
        <label
          htmlFor={`${promptId}-prompt`}
          className="text-xs font-semibold uppercase tracking-wide text-text-subtle"
        >
          {tw("editor.prompt.label")}
        </label>
        <Textarea
          id={`${promptId}-prompt`}
          rows={3}
          value={props.prompt}
          placeholder={tw("editor.prompt.placeholder")}
          invalid={tooLong}
          aria-describedby={`${promptId}-counter`}
          onChange={(e) => props.onPromptChange(e.target.value)}
        />
        <p
          id={`${promptId}-counter`}
          className={cn(
            "text-right text-xs",
            tooLong ? "text-danger" : "text-text-muted",
          )}
        >
          {tooLong
            ? tw("editor.prompt.tooLong", { max: REGENERATE_PROMPT_MAX })
            : tw("editor.prompt.counter", {
                count: props.prompt.length,
                max: REGENERATE_PROMPT_MAX,
              })}
        </p>
        <Button
          variant="secondary"
          loading={props.regenerating}
          disabled={disabled || tooLong || props.regenerateBlockedBy !== null}
          onClick={props.onRegenerate}
        >
          {props.regenerating
            ? tw("editor.regenerating")
            : `⟳ ${tw("editor.regenerate")}`}
        </Button>
        {props.regenerateBlockedBy !== null && (
          <p className="text-xs text-text-muted">{tw(props.regenerateBlockedBy)}</p>
        )}
      </section>
    </div>
  );
}

function Thumb({
  media,
  kind,
}: {
  readonly media: MediaElement | null;
  readonly kind: "image" | "video" | "audio";
}) {
  const box = "h-12 w-9 flex-none overflow-hidden rounded bg-surface-sunken";
  if (media === null || kind === "audio") {
    return (
      <span aria-hidden className={cn(box, "flex items-center justify-center text-lg")}>
        ♪
      </span>
    );
  }
  return kind === "image" ? (
    <img src={media.url} alt="" className={cn(box, "object-cover")} loading="lazy" />
  ) : (
    <video
      src={media.url}
      muted
      playsInline
      preload="metadata"
      className={cn(box, "object-cover")}
    />
  );
}
