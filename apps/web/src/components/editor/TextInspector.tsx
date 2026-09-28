"use client";

import { isBrandFontFamily, type ContentTextBox } from "@fastgram/contracts";
import {
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  STROKE_WIDTH_MAX,
  STROKE_WIDTH_MIN,
  TEXT_BOX_MAX_LENGTH,
  TEXT_WIDTH_PERCENT_MAX,
  TEXT_WIDTH_PERCENT_MIN,
} from "@fastgram/contracts";
import { Checkbox, Input, Select, Textarea, cn } from "@fastgram/ui";
import { useId, useState, type ReactNode } from "react";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { EDITOR_FONTS, fontSpec } from "@/lib/editor/fonts";
import {
  brandFamilyOf,
  editorClosestWeight,
  editorCssFamily,
  editorWeights,
  useBrandLook,
  type EditorBrandLook,
} from "./brandLook";

export interface TextInspectorProps {
  readonly box: ContentTextBox | null;
  /** `Apply to all text boxes` sólo existe en slideshows (FR-051). */
  readonly canApplyToAll: boolean;
  readonly onChange: (
    patch: (box: ContentTextBox) => ContentTextBox,
    all: boolean,
  ) => void;
  readonly disabled?: boolean;
}

const WEIGHT_KEYS: Readonly<Record<number, CopyKey>> = {
  300: "editor.weight.300",
  400: "editor.weight.400",
  500: "editor.weight.500",
  600: "editor.weight.600",
  700: "editor.weight.700",
};

const HEX = /^#[0-9a-fA-F]{6}$/;

/**
 * El inspector `Text` de FR-051: contenido, familia, peso, tamaño, color,
 * contorno, fondo y ancho.
 *
 * **No hay alineación.** El brief la pide, pero la caja del contrato
 * (`contentTextBoxSchema`, DATA-009) no tiene `align`: el render la toma del
 * texto original del payload (`text-boxes-to-build-payload.ts`, `alignAt`).
 * Un control que no llega al video sería mentirle al usuario; queda reportado.
 *
 * `Apply to all text boxes` aplica **estilo**, no contenido: copiar el texto
 * de una caja en todas no es lo que nadie quiere al tildar eso.
 *
 * Sprint 9 (S): el selector de fuente ofrece primero las familias de la marca
 * (`brand:<id>`, del design system activo) con su nombre real y la marca de
 * licencia; las que esperan la licencia aparecen deshabilitadas (la API las
 * rechazaría con `brand_font_unavailable`).
 */
export function TextInspector({
  box,
  canApplyToAll,
  onChange,
  disabled = false,
}: TextInspectorProps) {
  const [applyAll, setApplyAll] = useState(false);
  const ids = useId();
  const look = useBrandLook();

  if (box === null) {
    return <p className="text-sm text-text-muted">{tw("editor.text.noSelection")}</p>;
  }

  const style = (patch: (b: ContentTextBox) => ContentTextBox) =>
    onChange(patch, canApplyToAll && applyAll);
  const family = box.font.family;
  const weights = editorWeights(family, look);
  const weightIndex = Math.max(0, weights.indexOf(box.font.weight));
  const brand = brandFamilyOf(family, look);

  return (
    <fieldset className="grid gap-4" disabled={disabled}>
      <legend className="sr-only">{tw("editor.text.title")}</legend>

      <Field id={`${ids}-content`} label={tw("editor.text.content")}>
        <Textarea
          id={`${ids}-content`}
          value={box.text}
          maxLength={TEXT_BOX_MAX_LENGTH}
          rows={3}
          onChange={(e) => {
            const text = e.target.value;
            // El contenido nunca se aplica a todas las cajas.
            onChange((b) => ({ ...b, text }), false);
          }}
        />
      </Field>

      {canApplyToAll && (
        <Checkbox
          checked={applyAll}
          onChange={(e) => setApplyAll(e.target.checked)}
          label={tw("editor.text.applyAll")}
        />
      )}

      <Field id={`${ids}-font`} label={tw("editor.text.font")}>
        <Select
          id={`${ids}-font`}
          value={family}
          style={{ fontFamily: editorCssFamily(family, look) }}
          onChange={(e) => {
            const next = e.target.value as ContentTextBox["font"]["family"];
            style((b) => ({
              ...b,
              font: {
                ...b.font,
                family: next,
                weight: editorClosestWeight(next, b.font.weight, look),
              },
            }));
          }}
          options={fontOptions(family, look)}
        />
        {isBrandFontFamily(family) ? (
          <p className="mt-1 text-xs text-text-muted">
            {tw(
              brand?.usable === true
                ? "editor.text.brandNote"
                : "editor.text.brandUnavailable",
            )}
          </p>
        ) : (
          fontSpec(family).googleFamily === null && (
            <p className="mt-1 text-xs text-text-muted">
              {tw("editor.text.fontFallback")}
            </p>
          )
        )}
      </Field>

      <Slider
        id={`${ids}-weight`}
        label={tw("editor.text.weight", {
          // Una cara de marca puede ser 100, 200, 800 o 900: sin nombre, el número.
          weight:
            WEIGHT_KEYS[box.font.weight] === undefined
              ? String(box.font.weight)
              : tw(WEIGHT_KEYS[box.font.weight] as CopyKey),
        })}
        min={0}
        max={weights.length - 1}
        step={1}
        value={weightIndex}
        disabled={weights.length < 2}
        onChange={(i) => {
          const weight = weights[i] ?? box.font.weight;
          style((b) => ({
            ...b,
            font: {
              ...b.font,
              weight: editorClosestWeight(b.font.family, weight, look),
            },
          }));
        }}
      />

      <Slider
        id={`${ids}-size`}
        label={tw("editor.text.size", { size: box.font.size })}
        min={FONT_SIZE_MIN}
        max={FONT_SIZE_MAX}
        step={1}
        value={box.font.size}
        onChange={(size) => style((b) => ({ ...b, font: { ...b.font, size } }))}
      />

      <Slider
        id={`${ids}-width`}
        label={tw("editor.text.width", { width: Math.round(box.widthPercent) })}
        min={TEXT_WIDTH_PERCENT_MIN}
        max={TEXT_WIDTH_PERCENT_MAX}
        step={1}
        value={box.widthPercent}
        onChange={(widthPercent) => style((b) => ({ ...b, widthPercent }))}
      />

      <ColorField
        id={`${ids}-color`}
        label={tw("editor.text.color")}
        value={box.color}
        onChange={(color) => style((b) => ({ ...b, color }))}
      />

      <Slider
        id={`${ids}-stroke`}
        label={tw("editor.text.stroke", { width: box.stroke.width })}
        min={STROKE_WIDTH_MIN}
        max={STROKE_WIDTH_MAX}
        step={1}
        value={box.stroke.width}
        onChange={(width) => style((b) => ({ ...b, stroke: { ...b.stroke, width } }))}
      />

      <ColorField
        id={`${ids}-stroke-color`}
        label={tw("editor.text.strokeColor")}
        value={box.stroke.color}
        onChange={(color) => style((b) => ({ ...b, stroke: { ...b.stroke, color } }))}
      />

      <BackgroundField id={`${ids}-bg`} box={box} onChange={style} />
    </fieldset>
  );
}

/**
 * Las opciones del selector: las familias de la marca primero (las que
 * esperan licencia, deshabilitadas), después las 12. Una familia de marca que
 * ya no está en el design system se conserva como opción deshabilitada para
 * que el `<select>` no mienta sobre lo que tiene la caja.
 */
export function fontOptions(
  current: string,
  look: EditorBrandLook,
): { value: string; label: string; disabled?: boolean }[] {
  const brand = look.families.map((f) => ({
    value: f.family,
    label: tw(
      !f.usable
        ? "editor.text.brandNeedsLicense"
        : f.license === "open"
          ? "editor.text.brandOpen"
          : "editor.text.brandLicensed",
      { name: f.name },
    ),
    ...(f.usable ? {} : { disabled: true }),
  }));
  const missing =
    isBrandFontFamily(current) && brandFamilyOf(current, look) === null
      ? [{ value: current, label: tw("editor.text.brandMissing"), disabled: true }]
      : [];
  return [
    ...missing,
    ...brand,
    ...EDITOR_FONTS.map((f) => ({ value: f.key as string, label: f.label })),
  ];
}

function Field({
  id,
  label,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-text-muted">
        {label}
      </label>
      {children}
    </div>
  );
}

export function Slider({
  id,
  label,
  min,
  max,
  step,
  value,
  onChange,
  disabled,
}: {
  readonly id: string;
  readonly label: string;
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly disabled?: boolean;
}) {
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-text-muted">
        {label}
      </label>
      <input
        id={id}
        type="range"
        className="fg-focusable w-full accent-[var(--fg-color-accent)]"
        min={min}
        max={max}
        step={step}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
      />
    </div>
  );
}

/**
 * Swatch + hex (FR-051: *"swatch + input hex (`#FFFFFF`)"*). El hex se aplica
 * recién cuando es un `#RRGGBB` válido: aplicar a medio escribir mandaría al
 * reducer un color que el contrato rechaza.
 */
export function ColorField({
  id,
  label,
  value,
  onChange,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (color: string) => void;
}) {
  const [text, setText] = useState(value);
  const [lastValue, setLastValue] = useState(value);
  if (value !== lastValue) {
    setLastValue(value);
    setText(value);
  }
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-xs font-medium text-text-muted">
        {label}
      </label>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type="color"
          className="fg-focusable h-9 w-10 cursor-pointer rounded border border-border bg-transparent p-0.5"
          value={value.toLowerCase()}
          onChange={(e) => onChange(e.target.value.toUpperCase())}
        />
        <Input
          aria-label={tw("editor.text.hex", { label })}
          value={text}
          maxLength={7}
          invalid={!HEX.test(text)}
          onChange={(e) => {
            const next = e.target.value.trim();
            setText(next);
            if (HEX.test(next)) onChange(next.toUpperCase());
          }}
        />
      </div>
    </div>
  );
}

type BgMode = "none" | "pill" | "full-width";

function BackgroundField({
  id,
  box,
  onChange,
}: {
  readonly id: string;
  readonly box: ContentTextBox;
  readonly onChange: (patch: (b: ContentTextBox) => ContentTextBox) => void;
}) {
  const bg = box.background;
  const mode: BgMode = bg === null ? "none" : bg.style;
  const setMode = (next: BgMode) =>
    onChange((b) => ({
      ...b,
      background:
        next === "none"
          ? null
          : {
              color: b.background?.color ?? "#FFFFFF",
              opacity: b.background?.opacity ?? 1,
              style: next,
            },
    }));
  const modes: readonly { value: BgMode; key: CopyKey }[] = [
    { value: "none", key: "editor.text.bgNone" },
    { value: "pill", key: "editor.text.bgPill" },
    { value: "full-width", key: "editor.text.bgFullWidth" },
  ];

  return (
    <div className="grid gap-2">
      <span id={`${id}-label`} className="text-xs font-medium text-text-muted">
        {tw("editor.text.background")}
      </span>
      <div role="group" aria-labelledby={`${id}-label`} className="flex gap-1">
        {modes.map((m) => (
          <button
            key={m.value}
            type="button"
            aria-pressed={mode === m.value}
            className={cn(
              "fg-focusable flex-1 rounded-md border px-2 py-1 text-xs",
              mode === m.value
                ? "border-accent bg-accent-subtle text-text"
                : "border-border text-text-muted hover:border-border-strong",
            )}
            onClick={() => setMode(m.value)}
          >
            {tw(m.key)}
          </button>
        ))}
      </div>
      {bg !== null && (
        <>
          <ColorField
            id={`${id}-color`}
            label={tw("editor.text.bgColor")}
            value={bg.color}
            onChange={(color) =>
              onChange((b) => ({
                ...b,
                background: b.background === null ? null : { ...b.background, color },
              }))
            }
          />
          <Slider
            id={`${id}-opacity`}
            label={tw("editor.text.bgOpacity", { opacity: Math.round(bg.opacity * 100) })}
            min={0}
            max={100}
            step={5}
            value={Math.round(bg.opacity * 100)}
            onChange={(pct) =>
              onChange((b) => ({
                ...b,
                background:
                  b.background === null ? null : { ...b.background, opacity: pct / 100 },
              }))
            }
          />
          <p className="text-xs text-text-muted">{tw("editor.text.bgRenderNote")}</p>
        </>
      )}
    </div>
  );
}
