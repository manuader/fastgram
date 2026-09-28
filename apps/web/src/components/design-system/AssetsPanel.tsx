"use client";

import type { DesignSystemResource } from "@fastgram/contracts";
import { Badge, Button } from "@fastgram/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw, type CopyKey } from "@/lib/i18n/t";

import {
  IMPORT_POLL_MS,
  designSystemKeys,
  useApprovePending,
  useDiscardPending,
  useGenerateAssets,
} from "./api";

/** Cuánto se sondea después de pedir una generación (el worker tarda segundos). */
export const GENERATE_POLL_WINDOW_MS = 120_000;

const KIND_COPY: Readonly<
  Record<DesignSystemResource["assets"][number]["kind"], CopyKey>
> = {
  logo: "designSystem.assets.kind.logo",
  imagery: "designSystem.assets.kind.imagery",
  motif: "designSystem.assets.kind.motif",
  generated: "designSystem.assets.kind.generated",
};

/**
 * Los assets del design system (ya en el Media Bank con el tag
 * `design-system`) y la generación de fondos nuevos: locales con la paleta
 * (sin proveedor) y, si hay modelo `image` configurado, con el modelo. Lo
 * generado queda pendiente hasta que se aprueba.
 */
export function AssetsPanel({ ds }: { readonly ds: DesignSystemResource }) {
  const generate = useGenerateAssets(ds.id);
  const approve = useApprovePending(ds.id);
  const discard = useDiscardPending(ds.id);
  const [queued, setQueued] = useState<{
    local: number;
    model: number;
    configured: boolean;
  } | null>(null);
  const client = useQueryClient();
  const pendingCount = ds.pendingAssets.length;
  const [waitingFrom, setWaitingFrom] = useState<number | null>(null);

  // Los pendientes llegan cuando el worker termina: se relee cada 3 s hasta
  // que aparece alguno nuevo o pasa la ventana.
  useEffect(() => {
    if (waitingFrom === null) return;
    if (pendingCount > waitingFrom) {
      setWaitingFrom(null);
      return;
    }
    const started = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - started > GENERATE_POLL_WINDOW_MS) {
        setWaitingFrom(null);
        return;
      }
      void client.invalidateQueries({ queryKey: designSystemKeys.all() });
    }, IMPORT_POLL_MS);
    return () => {
      clearInterval(timer);
    };
  }, [waitingFrom, pendingCount, client]);

  return (
    <div className="flex flex-col gap-2" aria-label={tw("designSystem.assets.title")}>
      <h3 className="m-0 text-base font-semibold">{tw("designSystem.assets.title")}</h3>
      {ds.assets.length === 0 ? (
        <p className="fgw-brand__note">{tw("designSystem.assets.none")}</p>
      ) : (
        <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3 p-0">
          {ds.assets.map((a) => (
            <li key={a.mediaId} className="flex flex-col gap-1">
              <img
                src={a.url}
                alt={a.filename}
                loading="lazy"
                className="aspect-square w-full rounded-md border border-border bg-surface-sunken object-contain"
              />
              <Badge>{tw(KIND_COPY[a.kind])}</Badge>
            </li>
          ))}
        </ul>
      )}

      <h4 className="m-0 mt-2 text-sm font-semibold">
        {tw("designSystem.generate.title")}
      </h4>
      <p className="fgw-brand__note m-0">{tw("designSystem.generate.body")}</p>
      <div className="fgw-brand-section__actions">
        <Button
          size="sm"
          variant="secondary"
          loading={generate.isPending}
          onClick={() => {
            generate.mutate(
              { localImages: 4, modelImages: 0 },
              {
                onSuccess: (r) => {
                  setQueued({
                    local: r.localImages,
                    model: r.modelImages,
                    configured: r.imageModelConfigured,
                  });
                  setWaitingFrom(pendingCount);
                },
              },
            );
          }}
        >
          {tw("designSystem.generate.local")}
        </Button>
        <Button
          size="sm"
          variant="secondary"
          loading={generate.isPending}
          onClick={() => {
            generate.mutate(
              { localImages: 2, modelImages: 2 },
              {
                onSuccess: (r) => {
                  setQueued({
                    local: r.localImages,
                    model: r.modelImages,
                    configured: r.imageModelConfigured,
                  });
                  setWaitingFrom(pendingCount);
                },
              },
            );
          }}
        >
          {tw("designSystem.generate.withModel")}
        </Button>
      </div>
      {queued !== null && (
        <p className="fgw-brand__note" role="status">
          {tw(
            queued.configured
              ? "designSystem.generate.queued"
              : "designSystem.generate.queuedNoModel",
            {
              count: String(queued.local + queued.model),
            },
          )}
        </p>
      )}
      {generate.isError && <ApiErrorState error={generate.error} />}

      {ds.pendingAssets.length > 0 && (
        <>
          <h4 className="m-0 mt-2 text-sm font-semibold">
            {tw("designSystem.pending.title", { count: String(ds.pendingAssets.length) })}
          </h4>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(8rem,1fr))] gap-3 p-0">
            {ds.pendingAssets.map((p) => (
              <li
                key={p.id}
                className="flex flex-col gap-1"
                data-testid={`ds-pending-${p.id}`}
              >
                <img
                  src={p.url}
                  alt=""
                  loading="lazy"
                  className="aspect-square w-full rounded-md border border-border bg-surface-sunken object-contain"
                />
                <Badge>
                  {tw(
                    p.generator === "model"
                      ? "designSystem.pending.model"
                      : "designSystem.pending.local",
                  )}
                </Badge>
                <div className="flex gap-1">
                  <Button
                    size="sm"
                    disabled={approve.isPending || discard.isPending}
                    onClick={() => {
                      approve.mutate(p.id);
                    }}
                  >
                    {tw("designSystem.pending.approve")}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={approve.isPending || discard.isPending}
                    onClick={() => {
                      discard.mutate(p.id);
                    }}
                  >
                    {tw("designSystem.pending.discard")}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {(approve.isError || discard.isError) && (
        <ApiErrorState error={approve.error ?? discard.error} />
      )}
    </div>
  );
}
