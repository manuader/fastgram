"use client";

import type { StudioFormat } from "@fastgram/contracts";
import { tw } from "@/lib/i18n/t";
import type { StudioDraft, StudioPick } from "@/lib/studio/studio";

/**
 * Aproximación del look de cada preset (`FR-055`) para el preview. El render
 * real sale de `CAPTION_STYLES` de `@fastgram/core` (la web no depende de
 * `core`): esto es una guía visual, y el editor muestra la pieza de verdad.
 */
const PREVIEW_STYLE: Readonly<
  Record<string, { color: string; stroke?: string; background?: string; weight: number }>
> = {
  "tiktok-classic": { color: "#FFFFFF", stroke: "#000000", weight: 500 },
  "bold-impact": { color: "#FFFFFF", stroke: "#000000", weight: 800 },
  snapchat: { color: "#FFFFFF", background: "rgba(0,0,0,0.75)", weight: 500 },
  "white-box": { color: "#000000", background: "#FFFFFF", weight: 600 },
  "yellow-pop": { color: "#FFD600", stroke: "#000000", weight: 800 },
  "clean-karaoke": { color: "#FFFFFF", stroke: "#000000", weight: 600 },
  "script-playful": { color: "#FFFFFF", stroke: "#000000", weight: 400 },
};

/** Dónde va el texto, como en `composeBlitzBuildPayload` (fracción del alto). */
const TEXT_TOP: Readonly<Record<StudioFormat, string>> = {
  slideshow: "50%",
  "wall-of-text": "50%",
  "green-screen": "15%",
  "video-hook": "25%",
};

function Layer({
  pick,
  className,
}: {
  readonly pick: StudioPick | null;
  readonly className: string;
}) {
  if (pick === null) return <span className={`${className} bg-surface-sunken`} />;
  return pick.mediaType === "image" ? (
    <img src={pick.url} alt="" className={`${className} object-cover`} />
  ) : (
    <video
      src={pick.url}
      muted
      loop
      autoPlay
      playsInline
      className={`${className} object-cover`}
    />
  );
}

export function StudioPreview({
  format,
  draft,
}: {
  readonly format: StudioFormat;
  readonly draft: StudioDraft;
}) {
  const style = PREVIEW_STYLE[draft.stylePresetId] ?? PREVIEW_STYLE["tiktok-classic"];
  const text =
    draft.textMode === "ai"
      ? tw("studio.preview.aiText")
      : (draft.texts[0] ?? "").trim() || tw("studio.preview.placeholder");
  const aspect =
    format === "slideshow" ? draft.aspectRatio.replace(":", " / ") : "9 / 16";

  return (
    <div className="sticky top-4 flex flex-col gap-2">
      <span className="text-xs font-medium text-text-muted">{tw("studio.preview")}</span>
      <div
        className="relative w-full overflow-hidden rounded-lg border border-border bg-black"
        style={{ aspectRatio: aspect }}
      >
        {format === "slideshow" && (
          <Layer
            pick={draft.slides[0] ?? null}
            className="absolute inset-0 h-full w-full"
          />
        )}
        {format === "wall-of-text" && (
          <Layer pick={draft.video} className="absolute inset-0 h-full w-full" />
        )}
        {format === "green-screen" && (
          <>
            <Layer pick={draft.image} className="absolute inset-0 h-full w-full" />
            {draft.video !== null && (
              <Layer
                pick={draft.video}
                className="absolute inset-x-0 bottom-0 h-3/4 w-full opacity-90"
              />
            )}
          </>
        )}
        {format === "video-hook" && (
          <>
            <Layer
              pick={draft.hookVideo}
              className="absolute inset-x-0 top-0 h-1/2 w-full"
            />
            <Layer
              pick={draft.demoVideo}
              className="absolute inset-x-0 bottom-0 h-1/2 w-full"
            />
          </>
        )}
        {style !== undefined && (
          <span
            className="absolute left-[5%] w-[90%] -translate-y-1/2 whitespace-pre-wrap break-words px-1 text-center text-sm leading-snug"
            style={{
              top: TEXT_TOP[format],
              color: style.color,
              fontWeight: style.weight,
              ...(style.background === undefined
                ? {}
                : { backgroundColor: style.background }),
              ...(style.stroke === undefined
                ? {}
                : {
                    WebkitTextStroke: `0.6px ${style.stroke}`,
                    paintOrder: "stroke fill",
                  }),
            }}
          >
            {text}
          </span>
        )}
      </div>
      {format === "slideshow" && draft.slides.length > 1 && (
        <span className="text-xs text-text-muted">
          {tw("studio.preview.slides", { count: draft.slides.length })}
        </span>
      )}
      <span className="text-xs text-text-muted">{tw("studio.preview.note")}</span>
    </div>
  );
}
