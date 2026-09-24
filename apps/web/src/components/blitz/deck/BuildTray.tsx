"use client";

import { Spinner, buttonVariants } from "@fastgram/ui";
import Link from "next/link";
import { ROUTES } from "@/lib/nav/routes";
import { tw } from "@/lib/i18n/t";
import { CONTENT_TYPE_COPY, useContentItem } from "@/lib/library/content";
import { td } from "@/lib/blitz/deck/copy";

/**
 * `Recent builds`: lo aceptado en esta sesión, con su build en vivo (FR-050
 * `processing` / `failed`, `PU-BLITZ-002`).
 *
 * Cada fila es un `useContentItem`, que ya hace el polling de ADR-014 —cada
 * 10 s mientras la pieza esté en `BUILDING`, y nada después—. La pieza llega
 * sembrada en la caché por `useAcceptSuggestion`, así que la fila aparece al
 * instante, sin esperar a la primera respuesta.
 *
 * La lista es de la sesión y no se persiste: la Library es donde viven las
 * piezas; esto es sólo el acuse de recibo mientras se sigue swipeando.
 */
export function BuildTray({ contentIds }: { contentIds: readonly string[] }) {
  if (contentIds.length === 0) return null;
  return (
    <section
      aria-label={td("deck.builds.title")}
      className="rounded-xl border border-border bg-surface p-4 shadow-sm"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text">{td("deck.builds.title")}</h2>
        <Link
          href={ROUTES.library}
          className={buttonVariants({ variant: "link", size: "sm" })}
        >
          {td("deck.builds.viewInLibrary")}
        </Link>
      </div>
      <ul className="space-y-2">
        {contentIds.map((id) => (
          <BuildRow key={id} contentId={id} />
        ))}
      </ul>
      <p className="mt-3 text-xs text-text-subtle">{td("deck.builds.hint")}</p>
    </section>
  );
}

function BuildRow({ contentId }: { contentId: string }) {
  const { data } = useContentItem(contentId);
  const status = data?.status ?? "BUILDING";
  const typeLabel = data === undefined ? "…" : tw(CONTENT_TYPE_COPY[data.type]);

  return (
    <li
      className="flex items-center gap-3 rounded-lg bg-surface-sunken p-2"
      data-testid="build-row"
      data-status={status}
    >
      <span className="relative h-12 w-[27px] shrink-0 overflow-hidden rounded bg-surface">
        {data?.thumbnailUrl !== undefined && (
          // `<img>`: mismo motivo que `ContentCard` (hosts no declarados en Next).
          <img src={data.thumbnailUrl} alt="" className="h-full w-full object-cover" />
        )}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-text">{typeLabel}</span>
        <span
          className="flex items-center gap-1.5 text-xs"
          role="status"
          style={{
            color:
              status === "FAILED"
                ? "var(--fg-color-danger)"
                : status === "CREATED"
                  ? "var(--fg-color-success)"
                  : "var(--fg-color-text-muted)",
          }}
        >
          {status === "BUILDING" && <Spinner size="sm" aria-hidden />}
          {status === "BUILDING"
            ? td("deck.builds.building")
            : status === "CREATED"
              ? td("deck.builds.ready")
              : td("deck.builds.failed")}
        </span>
      </span>
      {status !== "BUILDING" && (
        <Link
          href={`${ROUTES.library}/${encodeURIComponent(contentId)}`}
          className={buttonVariants({ variant: "ghost", size: "sm" })}
        >
          {td("deck.builds.open")}
        </Link>
      )}
    </li>
  );
}
