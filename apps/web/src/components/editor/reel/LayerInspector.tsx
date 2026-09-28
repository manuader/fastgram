"use client";

/**
 * Inspector de la capa elegida. Cada control cambia el spec (y por lo tanto la
 * preview y el render): no hay estado de UI que no termine en el spec.
 */
import {
  REEL_CAPTION_STYLES,
  REEL_MEDIA_ANIMATIONS,
  REEL_TEXT_ANIMATIONS,
  REEL_TEXT_MAX_LENGTH,
  REEL_TRANSITIONS,
  type FontFamily,
  type ReelLayer,
  type ReelSpec,
} from "@fastgram/contracts";
import { Button, Checkbox, Input, Select, Textarea } from "@fastgram/ui";
import { useId } from "react";
import { EDITOR_FONTS, closestWeight, fontSpec } from "@/lib/editor/fonts";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { ColorField, Slider } from "../TextInspector";
import { KIND_COPY } from "./ReelTimeline";

type Patch = (layer: ReelLayer) => ReelLayer;

export interface LayerInspectorProps {
  readonly spec: ReelSpec;
  readonly layer: ReelLayer | null;
  readonly onTiming: (start: number, end: number) => void;
  readonly onChange: (patch: Patch) => void;
  /** Abre el picker que corresponde para cambiar la media de la capa. */
  readonly onSwap: (layer: ReelLayer) => void;
  /** Reproduce la entrada de la capa en la preview. */
  readonly onPreviewAnimation: (layer: ReelLayer) => void;
  readonly disabled?: boolean;
}

const anim = (a: string): CopyKey => `editor.reel.anim.${a}` as CopyKey;

function NumberField({
  label,
  value,
  min,
  max,
  onCommit,
  disabled,
}: {
  readonly label: string;
  readonly value: number;
  readonly min: number;
  readonly max: number;
  readonly onCommit: (value: number) => void;
  readonly disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-text-muted">
        {label}
      </label>
      <Input
        id={id}
        type="number"
        step={0.1}
        min={min}
        max={max}
        value={Number(value.toFixed(2))}
        disabled={disabled === true}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onCommit(n);
        }}
      />
    </div>
  );
}

export function LayerInspector({
  spec,
  layer,
  onTiming,
  onChange,
  onSwap,
  onPreviewAnimation,
  disabled,
}: LayerInspectorProps) {
  const id = useId();
  const off = disabled === true;
  if (layer === null) {
    return <p className="text-sm text-text-muted">{tw("editor.reel.noSelection")}</p>;
  }
  const kind = tw(KIND_COPY[layer.kind]);
  const set =
    <K extends ReelLayer>(fn: (l: K) => K): Patch =>
    (l) =>
      fn(l as K);

  return (
    <div className="grid gap-4" data-testid="reel-inspector">
      <h3 className="text-sm font-semibold text-text">{kind}</h3>
      <div className="grid grid-cols-2 gap-2">
        <NumberField
          label={tw("editor.reel.start")}
          value={layer.start}
          min={0}
          max={spec.durationSec}
          disabled={off}
          onCommit={(n) => onTiming(n, layer.end)}
        />
        <NumberField
          label={tw("editor.reel.end")}
          value={layer.end}
          min={0}
          max={spec.durationSec}
          disabled={off}
          onCommit={(n) => onTiming(layer.start, n)}
        />
      </div>

      {layer.kind === "text" && (
        <>
          <div className="grid gap-1.5">
            <label htmlFor={`${id}-text`} className="text-xs font-medium text-text-muted">
              {tw("editor.reel.text")}
            </label>
            <Textarea
              id={`${id}-text`}
              value={layer.text}
              maxLength={REEL_TEXT_MAX_LENGTH}
              disabled={off}
              onChange={(e) => {
                const text = e.target.value;
                onChange(set<typeof layer>((l) => ({ ...l, text })));
              }}
            />
          </div>
          <Select
            aria-label={tw("editor.reel.font")}
            value={layer.font.family}
            disabled={off}
            onChange={(e) => {
              const family = e.target.value as FontFamily;
              onChange(
                set<typeof layer>((l) => ({
                  ...l,
                  font: {
                    ...l.font,
                    family,
                    weight: closestWeight(family, l.font.weight),
                  },
                })),
              );
            }}
            options={EDITOR_FONTS.map((f) => ({ value: f.key, label: f.label }))}
          />
          {fontSpec(layer.font.family).weights.length > 1 && (
            <Slider
              id={`${id}-weight`}
              label={tw("editor.reel.weight", { weight: layer.font.weight })}
              min={0}
              max={fontSpec(layer.font.family).weights.length - 1}
              step={1}
              value={Math.max(
                0,
                fontSpec(layer.font.family).weights.indexOf(layer.font.weight),
              )}
              disabled={off}
              onChange={(i) => {
                const weight =
                  fontSpec(layer.font.family).weights[i] ?? layer.font.weight;
                onChange(
                  set<typeof layer>((l) => ({ ...l, font: { ...l.font, weight } })),
                );
              }}
            />
          )}
          <Slider
            id={`${id}-size`}
            label={tw("editor.reel.size", { size: layer.font.size })}
            min={8}
            max={72}
            step={1}
            value={layer.font.size}
            disabled={off}
            onChange={(size) =>
              onChange(set<typeof layer>((l) => ({ ...l, font: { ...l.font, size } })))
            }
          />
          <ColorField
            id={`${id}-color`}
            label={tw("editor.reel.color")}
            value={layer.color}
            onChange={(color) => onChange(set<typeof layer>((l) => ({ ...l, color })))}
          />
          <Slider
            id={`${id}-stroke`}
            label={tw("editor.reel.stroke", { width: layer.stroke.width })}
            min={0}
            max={8}
            step={1}
            value={layer.stroke.width}
            disabled={off}
            onChange={(width) =>
              onChange(
                set<typeof layer>((l) => ({ ...l, stroke: { ...l.stroke, width } })),
              )
            }
          />
          <ColorField
            id={`${id}-stroke-color`}
            label={tw("editor.reel.strokeColor")}
            value={layer.stroke.color}
            onChange={(color) =>
              onChange(
                set<typeof layer>((l) => ({ ...l, stroke: { ...l.stroke, color } })),
              )
            }
          />
          <div className="grid gap-2">
            <Select
              aria-label={tw("editor.reel.animation")}
              value={layer.animation}
              disabled={off}
              onChange={(e) => {
                const animation = e.target.value as (typeof REEL_TEXT_ANIMATIONS)[number];
                onChange(set<typeof layer>((l) => ({ ...l, animation })));
              }}
              options={REEL_TEXT_ANIMATIONS.map((a) => ({
                value: a,
                label: tw(anim(a)),
              }))}
            />
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onPreviewAnimation(layer)}
            >
              {tw("editor.reel.previewAnimation")}
            </Button>
          </div>
          <Checkbox
            label={tw("editor.reel.exitFade")}
            checked={layer.exit === "fade"}
            disabled={off}
            onChange={(e) => {
              const exit = e.target.checked ? "fade" : "none";
              onChange(set<typeof layer>((l) => ({ ...l, exit })));
            }}
          />
        </>
      )}

      {(layer.kind === "clip" ||
        layer.kind === "image" ||
        layer.kind === "audio" ||
        (layer.kind === "background" &&
          (layer.fill.type === "image" || layer.fill.type === "video"))) && (
        <Button
          size="sm"
          variant="secondary"
          disabled={off}
          onClick={() => onSwap(layer)}
        >
          {layer.kind === "audio"
            ? tw("editor.reel.swapMusic")
            : tw("editor.reel.swap", { kind })}
        </Button>
      )}

      {layer.kind === "clip" && (
        <>
          <Select
            aria-label={tw("editor.reel.chroma")}
            value={layer.chroma}
            disabled={off}
            onChange={(e) => {
              const chroma = e.target.value as typeof layer.chroma;
              onChange(set<typeof layer>((l) => ({ ...l, chroma })));
            }}
            options={(["green", "blue", "alpha", "none"] as const).map((c) => ({
              value: c,
              label: tw(`editor.reel.chroma.${c}` as CopyKey),
            }))}
          />
          <Select
            aria-label={tw("editor.reel.fit")}
            value={layer.fit}
            disabled={off}
            onChange={(e) => {
              const fit = e.target.value as typeof layer.fit;
              onChange(set<typeof layer>((l) => ({ ...l, fit })));
            }}
            options={(["contain", "cover"] as const).map((f) => ({
              value: f,
              label: tw(`editor.reel.fit.${f}` as CopyKey),
            }))}
          />
          <Slider
            id={`${id}-volume`}
            label={tw("editor.reel.volume", { value: Math.round(layer.volume * 100) })}
            min={0}
            max={100}
            step={5}
            value={Math.round(layer.volume * 100)}
            disabled={off}
            onChange={(v) =>
              onChange(set<typeof layer>((l) => ({ ...l, volume: v / 100 })))
            }
          />
          <Checkbox
            label={tw("editor.reel.loop")}
            checked={layer.loop}
            disabled={off}
            onChange={(e) => {
              const loop = e.target.checked;
              onChange(set<typeof layer>((l) => ({ ...l, loop })));
            }}
          />
        </>
      )}

      {layer.kind === "image" && (
        <Select
          aria-label={tw("editor.reel.animation")}
          value={layer.animation}
          disabled={off}
          onChange={(e) => {
            const animation = e.target.value as typeof layer.animation;
            onChange(set<typeof layer>((l) => ({ ...l, animation })));
          }}
          options={REEL_MEDIA_ANIMATIONS.map((a) => ({ value: a, label: tw(anim(a)) }))}
        />
      )}

      {layer.kind === "background" && (
        <>
          {(layer.fill.type === "color" || layer.fill.type === "gradient") && (
            <ColorField
              id={`${id}-bg`}
              label={tw("editor.reel.color")}
              value={layer.fill.type === "color" ? layer.fill.color : layer.fill.from}
              onChange={(color) =>
                onChange(
                  set<typeof layer>((l) => ({
                    ...l,
                    fill:
                      l.fill.type === "color"
                        ? { ...l.fill, color }
                        : l.fill.type === "gradient"
                          ? { ...l.fill, from: color }
                          : l.fill,
                  })),
                )
              }
            />
          )}
          <Select
            aria-label={tw("editor.reel.transition")}
            value={layer.transitionIn.kind}
            disabled={off}
            onChange={(e) => {
              const k = e.target.value as (typeof REEL_TRANSITIONS)[number];
              onChange(
                set<typeof layer>((l) => ({
                  ...l,
                  transitionIn: { ...l.transitionIn, kind: k },
                })),
              );
            }}
            options={REEL_TRANSITIONS.map((t) => ({
              value: t,
              label: tw(`editor.reel.transition.${t}` as CopyKey),
            }))}
          />
        </>
      )}

      {layer.kind === "captions" && (
        <>
          <p className="text-xs text-text-muted">{tw("editor.reel.captionsAuto")}</p>
          <Select
            aria-label={tw("editor.reel.captionStyle")}
            value={layer.style}
            disabled={off}
            onChange={(e) => {
              const style = e.target.value as typeof layer.style;
              onChange(set<typeof layer>((l) => ({ ...l, style })));
            }}
            options={REEL_CAPTION_STYLES.map((s) => ({
              value: s,
              label: tw(`editor.reel.captionStyle.${s}` as CopyKey),
            }))}
          />
          <ColorField
            id={`${id}-cap-color`}
            label={tw("editor.reel.color")}
            value={layer.color}
            onChange={(color) => onChange(set<typeof layer>((l) => ({ ...l, color })))}
          />
          <ColorField
            id={`${id}-cap-active`}
            label={tw("editor.reel.activeColor")}
            value={layer.activeColor}
            onChange={(activeColor) =>
              onChange(set<typeof layer>((l) => ({ ...l, activeColor })))
            }
          />
          <Slider
            id={`${id}-cap-y`}
            label={tw("editor.reel.height", { value: Math.round(layer.positionY) })}
            min={5}
            max={95}
            step={1}
            value={layer.positionY}
            disabled={off}
            onChange={(positionY) =>
              onChange(set<typeof layer>((l) => ({ ...l, positionY })))
            }
          />
        </>
      )}

      {layer.kind === "audio" && (
        <>
          <Slider
            id={`${id}-a-volume`}
            label={tw("editor.reel.volume", { value: Math.round(layer.volume * 100) })}
            min={0}
            max={100}
            step={5}
            value={Math.round(layer.volume * 100)}
            disabled={off}
            onChange={(v) =>
              onChange(set<typeof layer>((l) => ({ ...l, volume: v / 100 })))
            }
          />
          <Slider
            id={`${id}-fade-in`}
            label={tw("editor.reel.fadeIn", { value: layer.fadeInSec })}
            min={0}
            max={5}
            step={0.1}
            value={layer.fadeInSec}
            disabled={off}
            onChange={(fadeInSec) =>
              onChange(set<typeof layer>((l) => ({ ...l, fadeInSec })))
            }
          />
          <Slider
            id={`${id}-fade-out`}
            label={tw("editor.reel.fadeOut", { value: layer.fadeOutSec })}
            min={0}
            max={5}
            step={0.1}
            value={layer.fadeOutSec}
            disabled={off}
            onChange={(fadeOutSec) =>
              onChange(set<typeof layer>((l) => ({ ...l, fadeOutSec })))
            }
          />
        </>
      )}
    </div>
  );
}
