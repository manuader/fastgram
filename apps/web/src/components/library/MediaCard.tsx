"use client";

import { Badge, Button, cn } from "@fastgram/ui";
import { useEffect, useRef, useState } from "react";
import { tw } from "@/lib/i18n/t";
import {
  MEDIA_CATEGORY_COPY,
  MEDIA_STATUS_COPY,
  formatDuration,
  formatSizeMb,
  formatUploadedAt,
} from "@/lib/media/media";
import type { Media } from "@fastgram/contracts";

export interface MediaCardProps {
  readonly item: Media;
  /** Abre la edición de categorías (`PATCH /media/:id`). Sin él, no hay botón. */
  readonly onEditCategories?: ((item: Media) => void) | undefined;
  /** Abre la confirmación de borrado. Sin él, no hay botón. */
  readonly onDelete?: ((item: Media) => void) | undefined;
  /** Etiquetas del modelo de visión (`PU-MEME-003`), si el clip las tiene. */
  readonly tags?: readonly string[] | undefined;
  /**
   * Modo `CREATING SET` (`P2-MEDIA-006`): checkbox circular arriba a la
   * izquierda (PRD:1650). Sin `onToggleSelect`, no hay modo selección.
   */
  readonly selected?: boolean | undefined;
  readonly onToggleSelect?: ((item: Media) => void) | undefined;
  /** Deep link `?focus=` (`FR-100.1`): se resalta y se lleva a la vista. */
  readonly focused?: boolean | undefined;
}

/**
 * Un asset del Media Bank (PRD:1626): miniatura, badge de categoría, nombre de
 * archivo, `<size> MB · <fecha>` y, en video, la duración.
 *
 * ## Tres cosas que el contrato no da, y qué se hace con cada una
 *
 * 1. **No hay URL de miniatura.** `mediaSchema` publica `r2Url` y nada más, así
 *    que una imagen se dibuja con el archivo entero: una foto de 10 MB —el tope
 *    de §9.8— se descarga completa para enseñarla a 168 px. Es un coste real y
 *    conocido; se paga porque la alternativa es una grid sin imágenes. La
 *    palanca es un campo de thumbnail en el contrato, no un truco de esta
 *    tarjeta.
 * 2. **Un video no tiene poster.** El contrato no publica miniatura, así que
 *    (sprint 7, segunda tanda) el hueco muestra **el primer frame** con un
 *    `<video preload="metadata">` apuntando a `#t=0.1`: el navegador pide los
 *    metadatos y el frame de ese instante con requests de rango, no el archivo
 *    entero. Sin autoplay, mudo y fuera del orden de tabulación: es una
 *    imagen. Mientras el asset no está `ready`, o si el navegador no puede
 *    decodificarlo (un `.mov` en Firefox, por ejemplo), vuelve el rótulo
 *    "Video" de antes en vez de un cuadro negro.
 * 3. **No hay pantalla de detalle de un asset.** §3.1 no lista ninguna ruta
 *    `/library/media/:id`, así que la tarjeta **no es un enlace**: un enlace a
 *    ninguna parte es peor que ninguno. Las dos acciones que sí hay —editar
 *    categorías y borrar (`PU-MEDIA-001`)— son botones propios en el pie.
 */
export function MediaCard({
  item,
  onEditCategories,
  onDelete,
  tags,
  selected,
  onToggleSelect,
  focused,
}: MediaCardProps) {
  const isImage = item.mediaType === "image";
  const category = item.categories[0];
  const notReady = item.status !== "ready";
  const ref = useRef<HTMLLIElement>(null);
  const shownTags = tags !== undefined && tags.length > 0 ? tags : item.tags;
  const [previewFailed, setPreviewFailed] = useState(false);
  const showVideoFrame = !isImage && item.status === "ready" && !previewFailed;

  useEffect(() => {
    if (focused === true) ref.current?.scrollIntoView?.({ block: "center" });
  }, [focused]);

  return (
    <li
      ref={ref}
      className={cn(
        "fgw-media-card relative",
        focused === true && "rounded-lg ring-2 ring-accent",
        selected === true && "rounded-lg ring-2 ring-accent",
      )}
      data-focused={focused === true ? "true" : undefined}
    >
      {onToggleSelect !== undefined && (
        <button
          type="button"
          role="checkbox"
          aria-checked={selected === true}
          aria-label={tw("mediaBank.sets.selectAria", { name: item.filename })}
          className={cn(
            "fg-focusable absolute left-2 top-2 z-10 flex h-6 w-6 items-center justify-center rounded-full border-2 text-xs",
            selected === true
              ? "border-accent bg-accent text-white"
              : "border-white bg-black/40 text-transparent",
          )}
          onClick={() => {
            onToggleSelect(item);
          }}
        >
          ✓
        </button>
      )}
      <span className="fgw-media-card__thumb" data-status={item.status}>
        {isImage ? (
          /* Igual que en `ContentCard`: `next/image` obligaría a declarar los
             dominios de origen en `next.config.ts`, y esta tarea no sabe
             cuáles son (R2 sigue en revisión, ADR-006). */
          <img className="fgw-media-card__image" src={item.r2Url} alt="" loading="lazy" />
        ) : showVideoFrame ? (
          <video
            className="fgw-media-card__image"
            src={`${item.r2Url}#t=0.1`}
            preload="metadata"
            muted
            playsInline
            aria-hidden="true"
            tabIndex={-1}
            data-testid="media-video-frame"
            onError={() => {
              setPreviewFailed(true);
            }}
          />
        ) : (
          <span className="fgw-media-card__placeholder">
            {tw("media.videoNoPreview")}
          </span>
        )}

        <span className="fgw-media-card__badge">
          <Badge tone={category === undefined ? "outline" : "neutral"} size="sm">
            {category === undefined
              ? tw("media.category.uncategorized")
              : tw(MEDIA_CATEGORY_COPY[category])}
          </Badge>
          {/* Con varias categorías, el badge nombra la primera y cuenta el
              resto: listar tres badges encima de 168 px tapa la miniatura. */}
          {item.categories.length > 1 && (
            <Badge tone="neutral" size="sm">
              {`+${String(item.categories.length - 1)}`}
            </Badge>
          )}
        </span>

        {item.videoDurationSec !== undefined && (
          <span
            className="fgw-media-card__duration"
            aria-label={tw("media.durationLabel", {
              duration: formatDuration(item.videoDurationSec),
            })}
          >
            {formatDuration(item.videoDurationSec)}
          </span>
        )}
      </span>

      <span className="fgw-media-card__foot">
        <span className="fgw-media-card__name" title={item.filename}>
          {item.filename}
        </span>
        <span className="fgw-media-card__meta">
          {tw("media.card.meta", {
            size: formatSizeMb(item.sizeMb),
            date: formatUploadedAt(item.uploadedAt),
          })}
        </span>
        {shownTags !== undefined && shownTags.length > 0 && (
          <span
            className="fgw-media-card__meta truncate"
            title={shownTags.join(", ")}
            aria-label={tw("media.card.tagsLabel", { tags: shownTags.join(", ") })}
          >
            {shownTags
              .slice(0, 4)
              .map((tag) => `#${tag}`)
              .join(" ")}
          </span>
        )}
        {notReady && (
          <span className="fgw-media-card__status" data-status={item.status}>
            {tw(MEDIA_STATUS_COPY[item.status])}
          </span>
        )}
        {item.normalization === "hdr_kept_original" && (
          <span className="fgw-media-card__meta" title={tw("mediaBank.hdrKept.hint")}>
            {tw("mediaBank.hdrKept")}
          </span>
        )}
        {onToggleSelect === undefined &&
          (onEditCategories !== undefined || onDelete !== undefined) && (
            <span
              role="group"
              aria-label={tw("mediaUpload.card.actionsLabel", { name: item.filename })}
              className="mt-1 flex gap-1"
            >
              {onEditCategories !== undefined && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={tw("mediaUpload.card.editAria", { name: item.filename })}
                  title={tw("mediaUpload.edit.title")}
                  onClick={() => {
                    onEditCategories(item);
                  }}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    className="h-3.5 w-3.5"
                    fill="none"
                  >
                    <path
                      d="M2.5 8.8V3.2c0-.4.3-.7.7-.7h5.6l4.7 4.7-6.3 6.3-4.7-4.7zM5.5 5.5h.01"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </Button>
              )}
              {onDelete !== undefined && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={tw("mediaUpload.card.deleteAria", { name: item.filename })}
                  title={tw("mediaUpload.delete.confirm")}
                  onClick={() => {
                    onDelete(item);
                  }}
                >
                  <svg
                    aria-hidden="true"
                    viewBox="0 0 16 16"
                    className="h-3.5 w-3.5"
                    fill="none"
                  >
                    <path
                      d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.3c0 .4.4.7.8.7h4.2c.4 0 .8-.3.8-.7l.6-8.3"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                </Button>
              )}
            </span>
          )}
      </span>
    </li>
  );
}
