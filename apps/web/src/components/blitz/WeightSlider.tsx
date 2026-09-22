"use client";

import { useId } from "react";
import { WEIGHT_SUM } from "@/lib/blitz/weights";

export interface WeightSliderProps {
  readonly label: string;
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly hint?: string | undefined;
}

/**
 * Un porcentaje de FR-055, con su valor a la vista.
 *
 * `step={1}` no es una comodidad: **las once columnas de `blitz_preferences`
 * son `integer()`**. La ruta sólo comprueba `influencerChance` —devuelve `400`
 * si llega con decimales, en vez de redondear en silencio— así que un decimal
 * en cualquiera de los otros llegaría hasta la base. Con el paso en 1 el
 * problema no existe desde el control.
 *
 * El valor se enseña siempre, y no sólo al arrastrar: FR-055 (PRD:1260) dibuja
 * *"Slider 0–100 % con valor a la derecha"*, y sin el número el usuario no
 * puede saber que el reequilibrio le dejó el mix donde él quería.
 *
 * El `<label>` va con `htmlFor` y no envolviendo al control, aunque el resto de
 * la shell use lo segundo. Aquí hay **texto suelto después del input** —el
 * `42%`— y un label que envuelve toma todo su contenido como nombre accesible:
 * el control pasaría a llamarse `Slideshow42%` y el nombre cambiaría con cada
 * arrastre.
 */
export function WeightSlider({ label, value, onChange, hint }: WeightSliderProps) {
  const inputId = useId();
  const hintId = useId();

  return (
    <div className="fgw-prefs-slider">
      <div className="fgw-prefs-slider__row">
        <label className="fgw-prefs-slider__label" htmlFor={inputId}>
          {label}
        </label>
        <input
          id={inputId}
          type="range"
          className="fgw-prefs-slider__input"
          min={0}
          max={WEIGHT_SUM}
          step={1}
          value={value}
          {...(hint === undefined ? {} : { "aria-describedby": hintId })}
          onChange={(event) => {
            onChange(Number(event.target.value));
          }}
        />
        <span className="fgw-prefs-slider__value">{`${String(value)}%`}</span>
      </div>
      {hint !== undefined && (
        <p id={hintId} className="fgw-prefs-slider__hint">
          {hint}
        </p>
      )}
    </div>
  );
}
