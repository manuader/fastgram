"use client";

import { ErrorState, Skeleton } from "@fastgram/ui";
import {
  ClapperboardIcon,
  EyeIcon,
  HeartIcon,
  MessageCircleIcon,
  UsersIcon,
  type IconProps,
} from "@/icons";
import { PAGINATION_LIMIT_MAX } from "@fastgram/contracts";
import { copyKeyForError } from "@/lib/api/errors";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { useHomeKpis, type HomeKpis } from "@/lib/home/kpis";
import type { ComponentType } from "react";

interface Tile {
  readonly id: keyof HomeKpis | "engagedLeads";
  readonly labelKey: CopyKey;
  readonly icon: ComponentType<IconProps>;
  readonly read: (kpis: HomeKpis) => number | null;
}

/** PRD:1034 — los cinco tiles, en el orden del PRD. */
const TILES: readonly Tile[] = [
  {
    id: "engagedLeads",
    labelKey: "home.kpi.engagedLeads",
    icon: UsersIcon,
    read: (k) => k.engagedLeads,
  },
  {
    id: "contentPosted",
    labelKey: "home.kpi.contentPosted",
    icon: ClapperboardIcon,
    read: (k) => k.contentPosted,
  },
  {
    id: "totalViews",
    labelKey: "home.kpi.totalViews",
    icon: EyeIcon,
    read: (k) => k.totalViews,
  },
  {
    id: "totalLikes",
    labelKey: "home.kpi.totalLikes",
    icon: HeartIcon,
    read: (k) => k.totalLikes,
  },
  {
    id: "totalComments",
    labelKey: "home.kpi.totalComments",
    icon: MessageCircleIcon,
    read: (k) => k.totalComments,
  },
];

const numberFormat = new Intl.NumberFormat("en-US");

/**
 * Fila de KPIs del Home · FR-030 (PRD:1034).
 *
 * Un valor que no se puede calcular se enseña como "Not available yet", **no**
 * como `0`. Un cero en `Total Views` es una afirmación —"nadie te vio"— y
 * afirmar eso cuando en realidad no hay endpoint es el peor tipo de bug de
 * producto: no falla, miente.
 */
export function KpiRow() {
  const { data, isPending, isError, error, refetch } = useHomeKpis();

  if (isError) {
    return (
      <ErrorState
        title={tw(copyKeyForError(error))}
        onRetry={() => {
          void refetch();
        }}
      />
    );
  }

  return (
    <section className="fgw-kpis" aria-busy={isPending}>
      <ul className="fgw-kpis__list">
        {TILES.map((tile) => {
          const Icon = tile.icon;
          const value = data === undefined ? null : tile.read(data);
          return (
            <li key={tile.id} className="fgw-kpi" data-metric={tile.id}>
              <span className="fgw-kpi__icon" aria-hidden="true">
                <Icon size={18} />
              </span>
              <span className="fgw-kpi__label">{tw(tile.labelKey)}</span>
              <span className="fgw-kpi__value">
                {isPending ? (
                  <Skeleton width={72} height={28} />
                ) : value === null ? (
                  <span className="fgw-kpi__unavailable">
                    {tw("home.kpi.unavailable")}
                  </span>
                ) : (
                  numberFormat.format(value)
                )}
              </span>
            </li>
          );
        })}
      </ul>
      {data?.partial === true && (
        <p className="fgw-kpis__note">
          {tw("home.kpi.partial", { limit: PAGINATION_LIMIT_MAX })}
        </p>
      )}
    </section>
  );
}
