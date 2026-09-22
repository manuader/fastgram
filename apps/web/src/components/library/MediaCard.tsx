"use client";

import { Badge } from "@fastgram/ui";
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
 * 2. **Un video no tiene poster.** No hay frame que pedir, así que el hueco
 *    lleva la duración y el tipo, no una imagen rota.
 * 3. **No hay pantalla de detalle de un asset.** §3.1 no lista ninguna ruta
 *    `/library/media/:id`, así que la tarjeta **no es un enlace**: un enlace a
 *    ninguna parte es peor que ninguno.
 */
export function MediaCard({ item }: MediaCardProps) {
  const isImage = item.mediaType === "image";
  const category = item.categories[0];
  const notReady = item.status !== "ready";

  return (
    <li className="fgw-media-card">
      <span className="fgw-media-card__thumb" data-status={item.status}>
        {isImage ? (
          /* Igual que en `ContentCard`: `next/image` obligaría a declarar los
             dominios de origen en `next.config.ts`, y esta tarea no sabe
             cuáles son (R2 sigue en revisión, ADR-006). */
          <img className="fgw-media-card__image" src={item.r2Url} alt="" loading="lazy" />
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
        {notReady && (
          <span className="fgw-media-card__status" data-status={item.status}>
            {tw(MEDIA_STATUS_COPY[item.status])}
          </span>
        )}
      </span>
    </li>
  );
}
