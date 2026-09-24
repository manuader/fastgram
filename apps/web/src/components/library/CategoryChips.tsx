"use client";

import { cn } from "@fastgram/ui";
import type { MediaCategory, MediaType } from "@fastgram/contracts";
import { CATEGORIES_BY_TYPE, MEDIA_CATEGORY_CHIP_COPY } from "@/lib/media/categories";
import { tw } from "@/lib/i18n/t";

export interface CategoryChipsProps {
  readonly mediaType: MediaType;
  readonly value: readonly MediaCategory[];
  readonly onToggle: (category: MediaCategory) => void;
  /** Nombre accesible del grupo: qué asset se está categorizando. */
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * El selector rápido de categorías (F-129). Sólo ofrece las válidas **para el
 * tipo** del asset: mostrar `hook-video` sobre una imagen sería ofrecer un
 * `400` con forma de chip.
 *
 * Cada chip es un `button` con `aria-pressed` y no un checkbox escondido: es
 * lo que un lector de pantalla anuncia como "botón de alternancia, pulsado",
 * que es exactamente lo que es.
 */
export function CategoryChips({
  mediaType,
  value,
  onToggle,
  label,
  disabled = false,
}: CategoryChipsProps) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap gap-2">
      {CATEGORIES_BY_TYPE[mediaType].map((category) => {
        const selected = value.includes(category);
        return (
          <button
            key={category}
            type="button"
            aria-pressed={selected}
            disabled={disabled}
            onClick={() => {
              onToggle(category);
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--fg-color-accent)]",
              "disabled:cursor-not-allowed disabled:opacity-60",
              selected
                ? "border-accent bg-accent-subtle text-text"
                : "border-border bg-surface text-text-muted hover:border-border-strong hover:text-text",
            )}
          >
            {selected && (
              <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3 w-3" fill="none">
                <path
                  d="M3.5 8.5l3 3 6-7"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
            {tw(MEDIA_CATEGORY_CHIP_COPY[category])}
          </button>
        );
      })}
    </div>
  );
}
