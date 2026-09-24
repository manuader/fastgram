"use client";

import { Button, Skeleton } from "@fastgram/ui";
import { useRouter } from "next/navigation";
import { BrandAvatar } from "@/components/brands/BrandAvatar";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";
import { RocketIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { useEnsureBrand } from "./use-brand-switch";

export interface ApprovalCardProps {
  /** Tarjetas en el Blitz de la marca activa. `null` = no se pudo saber. */
  readonly activeCount: number | null;
  readonly loading: boolean;
}

function cardsCopy(count: number): string {
  if (count === 0) return tw("today.approval.none");
  if (count === 1) return tw("today.approval.cardsOne");
  return tw("today.approval.cardsMany", { count });
}

/**
 * Esperando aprobación, por marca · `PU-UI-002`.
 *
 * **El número es sólo el de la marca activa**: la cola de Blitz es por marca y
 * el proxy no deja pedir la de otra (ver la cabecera de `lib/today/data.ts`).
 * Las demás marcas aparecen con su botón "Review" —que cambia a esa marca con el
 * mismo `switchTo` del selector y abre `/blitz`— y sin un número inventado.
 */
export function ApprovalCard({ activeCount, loading }: ApprovalCardProps) {
  const router = useRouter();
  const { active, workspaces } = useWorkspace();
  const ensureBrand = useEnsureBrand();

  const others = (workspaces.data ?? []).filter((w) => w.id !== active?.id);

  const review = (brandId: string | null) => {
    if (brandId !== null) ensureBrand(brandId);
    router.push(ROUTES.blitz);
  };

  return (
    <section
      aria-labelledby="today-approval-title"
      className="rounded-xl border border-border bg-surface p-5"
    >
      <h2
        id="today-approval-title"
        className="mb-3 flex items-center gap-2 text-base font-semibold text-text"
      >
        <RocketIcon size={16} />
        {tw("today.approval.title")}
      </h2>
      <ul className="flex flex-col gap-2">
        <li
          data-testid="today-approval-active"
          className="flex items-center gap-3 rounded-lg bg-surface-sunken p-3"
        >
          {active !== null && <BrandAvatar id={active.id} name={active.name} size="sm" />}
          <div className="flex min-w-0 flex-1 flex-col">
            <span className="truncate text-sm font-medium text-text">
              {active?.name ?? tw("today.approval.current")}
            </span>
            <div className="text-xs text-text-muted" data-testid="today-approval-count">
              {loading ? (
                <Skeleton width={56} height={12} />
              ) : activeCount === null ? (
                tw("today.counter.unavailable")
              ) : (
                cardsCopy(activeCount)
              )}
            </div>
          </div>
          <Button
            size="sm"
            variant={activeCount !== null && activeCount > 0 ? "primary" : "secondary"}
            onClick={() => {
              review(null);
            }}
          >
            {tw("today.approval.review")}
          </Button>
        </li>
        {others.map((brand) => (
          <li
            key={brand.id}
            data-testid="today-approval-brand"
            className="flex items-center gap-3 rounded-lg p-3"
          >
            <BrandAvatar id={brand.id} name={brand.name} size="sm" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="truncate text-sm font-medium text-text">{brand.name}</span>
              <span className="text-xs text-text-muted">
                {tw("today.approval.otherBrand")}
              </span>
            </span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={`${tw("today.approval.review")} · ${brand.name}`}
              onClick={() => {
                review(brand.id);
              }}
            >
              {tw("today.approval.review")}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}
