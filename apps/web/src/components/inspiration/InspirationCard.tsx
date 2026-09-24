"use client";

import { Badge, Button, Spinner } from "@fastgram/ui";
import type { InspirationItem } from "@fastgram/contracts";
import { EyeIcon, HeartIcon, TrashIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import { FORMAT_COPY, compactCount } from "@/lib/inspiration/inspiration";

/**
 * Una referencia del tablero — FR-040 adaptado.
 *
 * Tarjeta vertical 9:16 con la miniatura (una copia nuestra, no el hotlink
 * del sitio), overlay de vistas y likes **sólo si el sitio los dio** (un `0`
 * inventado sería un dato falso), autor, título, etiquetas, `Open original`
 * (`noopener noreferrer`, FR-040) y `Remix this`.
 *
 * Todo el texto de la tarjeta es de terceros: va como texto, nunca como HTML.
 */
export function InspirationCard({
  item,
  onRemix,
  onDelete,
  deleting,
}: {
  readonly item: InspirationItem;
  readonly onRemix: (item: InspirationItem) => void;
  readonly onDelete: (item: InspirationItem) => void;
  readonly deleting: boolean;
}) {
  const title = item.title ?? item.caption ?? tw("inspiration.card.untitled");
  const pending = item.ingestState === "pending";
  return (
    <article
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-sm"
      aria-busy={pending}
    >
      <div className="relative aspect-[9/16] w-full bg-surface-sunken">
        {item.thumbnailUrl !== undefined ? (
          // `<img>`: mismo motivo que `ContentCard` (hosts no declarados en Next).
          <img
            src={item.thumbnailUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center p-4 text-center text-sm text-text-muted">
            {pending ? (
              <span className="inline-flex items-center gap-2">
                {/* El texto de al lado ya dice qué pasa: sin `aria-hidden` el
                    lector leía "Loading..." y después el texto (P5-A11Y-001). */}
                <Spinner size="sm" aria-hidden="true" />
                {tw("inspiration.card.pending")}
              </span>
            ) : (
              <span className="line-clamp-6">{item.caption ?? title}</span>
            )}
          </div>
        )}
        {(item.views !== undefined || item.likes !== undefined) && (
          <div className="absolute inset-x-0 bottom-0 flex gap-3 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-6 text-xs font-medium text-white">
            {item.views !== undefined && (
              <span className="inline-flex items-center gap-1">
                <EyeIcon size={14} />
                <span aria-hidden="true">{compactCount(item.views)}</span>
                <span className="sr-only">
                  {tw("inspiration.card.views", { count: item.views })}
                </span>
              </span>
            )}
            {item.likes !== undefined && (
              <span className="inline-flex items-center gap-1">
                <HeartIcon size={14} />
                <span aria-hidden="true">{compactCount(item.likes)}</span>
                <span className="sr-only">
                  {tw("inspiration.card.likes", { count: item.likes })}
                </span>
              </span>
            )}
          </div>
        )}
        {item.format !== null && (
          <span className="absolute left-2 top-2">
            <Badge>{tw(FORMAT_COPY[item.format])}</Badge>
          </span>
        )}
      </div>

      <div className="flex flex-1 flex-col gap-2 p-3">
        <p className="line-clamp-2 text-sm font-medium text-text" title={title}>
          {title}
        </p>
        <p className="text-xs text-text-muted">
          {item.author ??
            (item.url === null
              ? tw("inspiration.card.fromMediaBank")
              : (item.platform ?? ""))}
        </p>
        {item.onScreenText.length > 0 && (
          <p className="line-clamp-2 text-xs text-text-muted">
            {tw("inspiration.card.onScreen", { text: item.onScreenText.join(" / ") })}
          </p>
        )}
        {item.ingestState === "failed" && (
          <p className="text-xs text-danger" role="status">
            {tw("inspiration.card.failed")}
          </p>
        )}
        {item.tags.length > 0 && (
          <ul className="flex flex-wrap gap-1" aria-label={tw("inspiration.filter.tag")}>
            {item.tags.map((tag) => (
              <li key={tag}>
                <Badge>{tag}</Badge>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-auto flex items-center gap-2 pt-1">
          <Button
            size="sm"
            onClick={() => {
              onRemix(item);
            }}
          >
            {tw("inspiration.card.remix")}
          </Button>
          {item.url !== null && (
            <a
              href={item.url}
              target="_blank"
              rel="noopener noreferrer"
              className="fg-focusable text-xs font-medium text-accent underline-offset-2 hover:underline"
            >
              {tw("inspiration.card.open")}
            </a>
          )}
          <Button
            size="icon"
            variant="ghost"
            className="ml-auto"
            aria-label={`${tw("inspiration.card.delete")}: ${title}`}
            disabled={deleting}
            onClick={() => {
              onDelete(item);
            }}
          >
            <TrashIcon size={14} />
          </Button>
        </div>
      </div>
    </article>
  );
}
