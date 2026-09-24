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
  /**
   * Tarjetas en cola por marca (`GET /blitz/queue/counts?brands=all`).
   * `undefined` = cargando; `null` = no se pudo saber.
   */
  readonly counts: ReadonlyMap<string, number> | null | undefined;
}

function cardsCopy(count: number): string {
  if (count === 0) return tw("today.approval.none");
  if (count === 1) return tw("today.approval.cardsOne");
  return tw("today.approval.cardsMany", { count });
}

/** El número de una marca, o por qué no lo hay. */
function CountLine({
  counts,
  brandId,
}: {
  counts: ReadonlyMap<string, number> | null | undefined;
  brandId: string | undefined;
}) {
  if (counts === undefined) return <Skeleton width={56} height={12} />;
  const count =
    brandId === undefined || counts === null ? undefined : counts.get(brandId);
  return <>{count === undefined ? tw("today.counter.unavailable") : cardsCopy(count)}</>;
}

/**
 * Esperando aprobación, por marca · `PU-UI-002`.
 *
 * Cada marca con su número (la cola agregada del dueño, ver
 * `lib/today/data.ts`) y su botón "Review", que cambia a esa marca con el mismo
 * `switchTo` del selector y abre `/blitz`. La activa va primera y resaltada.
 */
export function ApprovalCard({ counts }: ApprovalCardProps) {
  const router = useRouter();
  const { active, workspaces } = useWorkspace();
  const ensureBrand = useEnsureBrand();

  const others = (workspaces.data ?? []).filter((w) => w.id !== active?.id);
  const activeCount =
    active === null || counts === undefined || counts === null
      ? undefined
      : counts.get(active.id);

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
              <CountLine counts={counts} brandId={active?.id} />
            </div>
          </div>
          <Button
            size="sm"
            variant={
              activeCount !== undefined && activeCount > 0 ? "primary" : "secondary"
            }
            onClick={() => {
              review(null);
            }}
          >
            {tw("today.approval.review")}
          </Button>
        </li>
        {others.map((brand) => {
          const count =
            counts === undefined || counts === null ? undefined : counts.get(brand.id);
          return (
            <li
              key={brand.id}
              data-testid="today-approval-brand"
              className="flex items-center gap-3 rounded-lg p-3"
            >
              <BrandAvatar id={brand.id} name={brand.name} size="sm" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium text-text">
                  {brand.name}
                </span>
                <span
                  className="text-xs text-text-muted"
                  data-testid="today-approval-brand-count"
                >
                  <CountLine counts={counts} brandId={brand.id} />
                </span>
              </span>
              <Button
                size="sm"
                variant={count !== undefined && count > 0 ? "secondary" : "ghost"}
                aria-label={`${tw("today.approval.review")} · ${brand.name}`}
                onClick={() => {
                  review(brand.id);
                }}
              >
                {tw("today.approval.review")}
              </Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
