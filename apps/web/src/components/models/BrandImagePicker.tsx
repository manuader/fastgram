"use client";

import { Skeleton, buttonVariants, cn } from "@fastgram/ui";
import Link from "next/link";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { CheckIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { useBrandImages } from "./api";

export interface BrandImagePickerProps {
  /** La marca cuyo Media Bank se muestra (no tiene que ser la activa). */
  readonly brandId: string | null;
  readonly selected: readonly string[];
  readonly onChange: (next: string[]) => void;
  /** Cuántas se pueden elegir. Con 1, elegir otra reemplaza. */
  readonly max: number;
  readonly label: string;
  /** Ids que no se ofrecen (p. ej. la imagen del modelo al elegir productos). */
  readonly exclude?: readonly string[];
}

/**
 * Elegir imágenes listas del Media Bank de **una marca del dueño**, vía
 * `GET /character-models/brands/:brandId/media` (owner-level: no hace falta
 * cambiar de marca). Para subir nuevas se va a la Library, que ya tiene la
 * subida con sus validaciones.
 */
export function BrandImagePicker({
  brandId,
  selected,
  onChange,
  max,
  label,
  exclude = [],
}: BrandImagePickerProps) {
  const media = useBrandImages(brandId);
  const items = (media.data ?? []).filter(
    (m) =>
      m.mediaType === "image" && m.status === "ready" && !exclude.includes(m.mediaId),
  );

  const toggle = (id: string) => {
    if (selected.includes(id)) {
      onChange(selected.filter((s) => s !== id));
    } else if (max === 1) {
      onChange([id]);
    } else if (selected.length < max) {
      onChange([...selected, id]);
    }
  };

  if (brandId === null) {
    return (
      <p className="m-0 text-sm text-text-muted">{tw("charModels.picker.noBrand")}</p>
    );
  }
  if (media.isError) {
    return (
      <ApiErrorState
        error={media.error}
        onRetry={() => {
          void media.refetch();
        }}
      />
    );
  }
  if (media.isPending) {
    return (
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-5" aria-busy="true">
        {Array.from({ length: 10 }, (_, i) => (
          <Skeleton key={i} className="aspect-square rounded-lg" />
        ))}
      </div>
    );
  }
  if (items.length === 0) {
    return (
      <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed border-border-strong p-4">
        <p className="m-0 text-sm text-text-muted">{tw("charModels.picker.empty")}</p>
        <Link
          href={ROUTES.library}
          className={buttonVariants({ variant: "secondary", size: "sm" })}
        >
          {tw("charModels.picker.upload")}
        </Link>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-sm font-medium text-text">{label}</span>
        <span className="text-sm tabular-nums text-text-muted" aria-live="polite">
          {tw("charModels.picker.count", { count: selected.length, max })}
        </span>
      </div>
      <ul
        className="m-0 grid max-h-72 list-none grid-cols-3 gap-2 overflow-y-auto p-0 sm:grid-cols-5"
        aria-label={label}
      >
        {items.map((m) => {
          const on = selected.includes(m.mediaId);
          return (
            <li key={m.mediaId}>
              <button
                type="button"
                aria-pressed={on}
                onClick={() => {
                  toggle(m.mediaId);
                }}
                className={cn(
                  "relative block aspect-square w-full overflow-hidden rounded-lg border-2",
                  on ? "border-accent" : "border-transparent",
                )}
              >
                <img
                  src={m.r2Url}
                  alt={m.filename}
                  loading="lazy"
                  className="h-full w-full object-cover"
                />
                {on && (
                  <span className="absolute right-1 top-1 rounded-full bg-accent p-0.5 text-white">
                    <CheckIcon size={12} />
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
