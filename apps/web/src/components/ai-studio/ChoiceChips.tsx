"use client";

import { cn } from "@fastgram/ui";
import { useRef, type KeyboardEvent } from "react";

export interface Choice<T extends string | number> {
  readonly value: T;
  readonly label: string;
}

export interface ChoiceChipsProps<T extends string | number> {
  readonly label: string;
  readonly choices: readonly Choice<T>[];
  readonly value: T;
  readonly onChange: (value: T) => void;
  readonly disabled?: boolean;
  readonly name: string;
}

/**
 * Un grupo de opciones cortas (relación, cantidad, duración) como radios con
 * forma de chip: `role="radiogroup"`, flechas para moverse, un solo tab-stop.
 */
export function ChoiceChips<T extends string | number>({
  label,
  choices,
  value,
  onChange,
  disabled = false,
  name,
}: ChoiceChipsProps<T>) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = Math.max(
    0,
    choices.findIndex((c) => c.value === value),
  );

  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const delta =
      e.key === "ArrowRight" || e.key === "ArrowDown"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowUp"
          ? -1
          : 0;
    if (delta === 0) return;
    e.preventDefault();
    const next = (index + delta + choices.length) % choices.length;
    const choice = choices[next];
    if (choice === undefined) return;
    onChange(choice.value);
    refs.current[next]?.focus();
  };

  return (
    <div className="flex flex-col gap-2">
      <span id={`${name}-label`} className="text-sm font-medium text-text">
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={`${name}-label`}
        className="flex flex-wrap gap-2"
      >
        {choices.map((choice, index) => {
          const checked = index === selected;
          return (
            <button
              key={String(choice.value)}
              ref={(el) => {
                refs.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              disabled={disabled}
              onClick={() => {
                onChange(choice.value);
              }}
              onKeyDown={(e) => {
                onKeyDown(e, index);
              }}
              className={cn(
                "min-w-11 rounded-full border px-3 py-1.5 text-sm tabular-nums transition-colors",
                "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
                "disabled:cursor-not-allowed disabled:opacity-50",
                checked
                  ? "border-accent bg-accent-subtle font-medium text-accent"
                  : "border-border bg-surface text-text-muted hover:border-border-strong hover:text-text",
              )}
            >
              {choice.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
