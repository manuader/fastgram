"use client";

import type { InspirationItem } from "@fastgram/contracts";
import { Button, EmptyState, Input, Skeleton } from "@fastgram/ui";
import Link from "next/link";
import { useEffect, useState } from "react";
import { RemixDialog } from "@/components/inspiration/RemixDialog";
import { tw } from "@/lib/i18n/t";
import { useInspirationList } from "@/lib/inspiration/inspiration";
import { ROUTES } from "@/lib/nav/routes";

/**
 * Modo «Remix» del Studio (`F-071`, `P2-STUDIO-003`): partir de una referencia
 * de Inspiration. Reusa `RemixDialog` y su endpoint
 * (`POST /inspiration/:id/remix`): las piezas salen en Blitz, adaptadas a la
 * marca, con el mismo pipeline de «crear desde prompt». El picker de trending
 * de Fastlane (`F-074`) está fuera de alcance (D-15): la fuente es Inspiration.
 */
export function StudioRemix() {
  const [search, setSearch] = useState("");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [remixing, setRemixing] = useState<InspirationItem | null>(null);

  useEffect(() => {
    const id = window.setTimeout(() => {
      setQ(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(id);
  }, [search]);

  const query = useInspirationList({ q, format: null, tag: null, page });
  const items = query.data?.items ?? [];

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-text-muted">{tw("studio.remix.intro")}</p>
      <Input
        type="search"
        value={search}
        placeholder={tw("studio.remix.search")}
        aria-label={tw("studio.remix.search")}
        onChange={(e) => setSearch(e.target.value)}
      />

      {query.isPending ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="aspect-[9/16] w-full" />
          ))}
        </div>
      ) : query.isError && items.length === 0 ? (
        <EmptyState
          bordered
          title={tw("studio.remix.error")}
          action={
            <Button variant="secondary" onClick={() => void query.refetch()}>
              {tw("studio.retry")}
            </Button>
          }
        />
      ) : items.length === 0 ? (
        <EmptyState
          bordered
          title={tw("studio.remix.empty")}
          action={
            <Link href={ROUTES.inspiration} className="text-accent underline">
              {tw("studio.remix.goToInspiration")}
            </Link>
          }
        />
      ) : (
        <ul className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {items.map((item) => (
            <li
              key={item.id}
              className="flex flex-col gap-2 overflow-hidden rounded-lg border border-border"
            >
              <span className="relative block aspect-[9/16] w-full bg-surface-sunken">
                {item.thumbnailUrl !== undefined && (
                  <img
                    src={item.thumbnailUrl}
                    alt=""
                    loading="lazy"
                    className="h-full w-full object-cover"
                  />
                )}
              </span>
              <span
                className="truncate px-2 text-xs"
                title={item.title ?? item.caption ?? ""}
              >
                {item.title ?? item.caption ?? item.author ?? tw("studio.remix.untitled")}
              </span>
              <span className="px-2 pb-2">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={item.ingestState === "pending"}
                  onClick={() => setRemixing(item)}
                >
                  {tw("studio.remix.action")}
                </Button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {query.data !== undefined && (page > 1 || query.data.hasMore) && (
        <div className="flex justify-center gap-2">
          <Button
            variant="ghost"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            {tw("studio.remix.prev")}
          </Button>
          <Button
            variant="ghost"
            disabled={!query.data.hasMore}
            onClick={() => setPage((p) => p + 1)}
          >
            {tw("studio.remix.next")}
          </Button>
        </div>
      )}

      <RemixDialog item={remixing} onClose={() => setRemixing(null)} />
    </div>
  );
}
