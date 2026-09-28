"use client";

import { Button, Input, cn } from "@fastgram/ui";
import { useId, useState } from "react";
import { tw } from "@/lib/i18n/t";

export interface ChipListInputProps {
  readonly label: string;
  readonly values: readonly string[];
  readonly onChange: (values: readonly string[]) => void;
  /** Tope de ítems y de largo de cada uno: los mismos del contrato. */
  readonly max: number;
  readonly maxLength: number;
  readonly placeholder?: string;
}

/**
 * Una lista de frases cortas editable como chips (`useCases`, `characters`,
 * `tags`). Enter o `Add` agrega; la × quita. Los duplicados se ignoran en vez
 * de mostrar un error: dos veces la misma etiqueta no le dice nada nuevo al
 * modelo que elige, y avisarlo sería ruido.
 */
export function ChipListInput({
  label,
  values,
  onChange,
  max,
  maxLength,
  placeholder,
}: ChipListInputProps) {
  const id = useId();
  const [draft, setDraft] = useState("");
  const full = values.length >= max;

  const add = () => {
    const value = draft.trim();
    if (value === "" || full) return;
    if (!values.includes(value)) onChange([...values, value]);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-1.5" role="group" aria-labelledby={`${id}-label`}>
      <span id={`${id}-label`} className="text-sm font-medium text-text">
        {label}
        <span className="ml-1 text-xs font-normal text-text-subtle">
          {tw("globalLibrary.detail.chips.count", {
            count: values.length,
            max,
          })}
        </span>
      </span>
      {values.length > 0 && (
        <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
          {values.map((value) => (
            <li
              key={value}
              className={cn(
                "flex items-center gap-1 rounded-full border border-border bg-surface-sunken py-0.5 pl-2.5 pr-1 text-xs text-text",
              )}
            >
              <span>{value}</span>
              <button
                type="button"
                className="fg-focusable rounded-full px-1 text-text-muted hover:text-text"
                aria-label={tw("globalLibrary.detail.chips.remove", { value })}
                onClick={() => {
                  onChange(values.filter((v) => v !== value));
                }}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex gap-2">
        <Input
          id={id}
          value={draft}
          maxLength={maxLength}
          disabled={full}
          aria-label={label}
          {...(placeholder === undefined ? {} : { placeholder })}
          onChange={(e) => {
            setDraft(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          wrapperClassName="flex-1"
        />
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={full || draft.trim() === ""}
          onClick={add}
        >
          {tw("globalLibrary.detail.chips.add")}
        </Button>
      </div>
    </div>
  );
}
