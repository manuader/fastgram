"use client";

import type { AutopilotBrandDigest } from "@fastgram/contracts";
import { Button } from "@fastgram/ui";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { BrandAvatar } from "@/components/brands/BrandAvatar";
import { ZapIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { outcomeKey, reasonKey, reasonTally, useAutopilotDigest } from "./autopilot-data";
import { useEnsureBrand } from "./use-brand-switch";

/** Cuántos motivos se muestran sin abrir la lista. */
const TOP_REASONS = 3;

function formatTime(msEpoch: number, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(new Date(msEpoch));
}

/**
 * La tarjeta "Autopilot" de Today · `PU-AUTO-003` (`D-08`).
 *
 * Una fila por marca **en piloto** (o que tuvo decisiones hoy aunque ya no lo
 * esté): aprobadas solas, rechazadas con sus motivos legibles, las que esperan
 * al humano porque el pre-chequeo no respondió, y qué se publicó y qué falló.
 * "Review rejected" abre la lista de las rechazadas con su copy y su motivo;
 * "Review in Blitz" cambia a la marca y abre el deck, donde están las que
 * esperan.
 *
 * Sin marcas en piloto no se dibuja nada: es una tarjeta sobre el piloto, no
 * un aviso de que existe (eso vive en Settings → Strategy). Mientras carga
 * tampoco: aparecer y desaparecer en la columna sería peor que llegar tarde.
 */
export function AutopilotCard({ timeZone }: { readonly timeZone: string }) {
  const digest = useAutopilotDigest("all");

  if (digest.isPending) return null;
  if (digest.isError) {
    return (
      <section
        aria-labelledby="today-autopilot-title"
        className="rounded-xl border border-border bg-surface p-5"
        data-testid="today-autopilot"
      >
        <Title />
        <p className="mb-3 text-sm text-text-muted">{tw("autopilot.card.error")}</p>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            void digest.refetch();
          }}
        >
          {tw("autopilot.card.retry")}
        </Button>
      </section>
    );
  }

  const brands = digest.data.brands.filter(
    (b) =>
      b.autonomy === "autopilot" ||
      b.approved.length + b.rejected.length + b.held.length > 0,
  );
  if (brands.length === 0) return null;

  return (
    <section
      aria-labelledby="today-autopilot-title"
      className="rounded-xl border border-border bg-surface p-5"
      data-testid="today-autopilot"
    >
      <Title />
      <p className="mb-3 text-xs text-text-muted">{tw("autopilot.card.subtitle")}</p>
      <ul className="flex flex-col gap-3">
        {brands.map((brand) => (
          <BrandRow key={brand.brandId} brand={brand} timeZone={timeZone} />
        ))}
      </ul>
    </section>
  );
}

function Title() {
  return (
    <h2
      id="today-autopilot-title"
      className="mb-1 flex items-center gap-2 text-base font-semibold text-text"
    >
      <ZapIcon size={16} />
      {tw("autopilot.card.title")}
    </h2>
  );
}

function BrandRow({
  brand,
  timeZone,
}: {
  readonly brand: AutopilotBrandDigest;
  readonly timeZone: string;
}) {
  const router = useRouter();
  const ensureBrand = useEnsureBrand();
  const [open, setOpen] = useState(false);
  const listId = useId();
  const tally = reasonTally(brand.rejected);
  const decided = brand.approved.length + brand.rejected.length + brand.held.length;
  const status = brand.lastRun === null ? null : outcomeKey(brand.lastRun.outcome);

  return (
    <li
      className="flex flex-col gap-2 rounded-lg bg-surface-sunken p-3"
      data-testid="today-autopilot-brand"
    >
      <div className="flex items-center gap-3">
        <BrandAvatar id={brand.brandId} name={brand.brandName} size="sm" />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-sm font-medium text-text">
            {brand.brandName}
          </span>
          <span className="text-xs text-text-muted">
            {brand.lastRun === null
              ? tw("autopilot.card.neverRan")
              : tw("autopilot.card.lastRun", {
                  time: formatTime(brand.lastRun.at, timeZone),
                })}
          </span>
        </div>
      </div>

      {status !== null && (
        <p className="text-xs text-warning" data-testid="today-autopilot-status">
          {tw(status)}
        </p>
      )}

      <p className="text-sm text-text" data-testid="today-autopilot-counts">
        {[
          tw("autopilot.card.approved", { count: brand.approved.length }),
          tw("autopilot.card.rejected", { count: brand.rejected.length }),
          ...(brand.held.length > 0
            ? [tw("autopilot.card.held", { count: brand.held.length })]
            : []),
        ].join(" · ")}
      </p>
      <p className="text-xs text-text-muted">
        {[
          tw("autopilot.card.generated", { count: brand.generated }),
          tw("autopilot.card.published", { count: brand.published }),
          tw("autopilot.card.failed", { count: brand.failed.length }),
        ].join(" · ")}
      </p>

      {decided === 0 && (
        <p className="text-xs text-text-muted">{tw("autopilot.card.nothing")}</p>
      )}

      {tally.length > 0 && (
        <ul
          className="flex flex-wrap gap-1.5"
          aria-label={tw("autopilot.card.rejected", {
            count: brand.rejected.length,
          })}
        >
          {tally.slice(0, TOP_REASONS).map(({ reason, count }) => (
            <li
              key={reason}
              className="rounded-full border border-border px-2 py-0.5 text-xs text-text-muted"
            >
              {tw(reasonKey(reason))}
              {count > 1 ? ` · ${String(count)}` : ""}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        {brand.rejected.length > 0 && (
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={open}
            aria-controls={listId}
            onClick={() => {
              setOpen((value) => !value);
            }}
          >
            {open
              ? tw("autopilot.card.hideRejected")
              : tw("autopilot.card.reviewRejected", { count: brand.rejected.length })}
          </Button>
        )}
        {brand.held.length > 0 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              ensureBrand(brand.brandId);
              router.push(ROUTES.blitz);
            }}
          >
            {tw("autopilot.card.reviewHeld")}
          </Button>
        )}
      </div>

      {open && (
        <ul
          id={listId}
          className="flex flex-col gap-2"
          data-testid="today-autopilot-rejected"
        >
          {brand.rejected.map((item) => (
            <li key={item.suggestionId} className="rounded-md border border-border p-2">
              <p className="line-clamp-2 text-sm text-text">{item.excerpt || "—"}</p>
              <p className="text-xs text-danger">
                {item.reasons.map((r) => tw(reasonKey(r))).join(" · ")}
              </p>
            </li>
          ))}
        </ul>
      )}

      {brand.truncated && (
        <p className="text-xs text-warning">{tw("autopilot.card.truncated")}</p>
      )}
    </li>
  );
}
