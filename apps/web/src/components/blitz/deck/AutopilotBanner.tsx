"use client";

import Link from "next/link";
import { ZapIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { useAutopilotDigest } from "@/components/today/autopilot-data";

/** `ROUTES` no tiene la de Strategy (la pantalla nació en `PU-BRAND-002`). */
const STRATEGY_HREF = `${ROUTES.settings}/strategy`;

/**
 * "Autopilot is on for this brand — N approved today" · `PU-AUTO-002` (`D-08`).
 *
 * Arriba del deck de la marca activa, **sólo** si su estrategia está en piloto:
 * explica por qué el deck puede tener menos tarjetas de las que el refill
 * dejó (el piloto se lleva las que pasan el pre-chequeo) y qué queda para el
 * humano. Mientras carga o si el resumen falla no se dibuja: un banner es
 * contexto, no puede tapar el deck ni ensuciarlo con un error ajeno a Blitz.
 */
export function AutopilotBanner() {
  const digest = useAutopilotDigest("current");
  const brand = digest.data?.brands[0];
  if (brand === undefined || brand.autonomy !== "autopilot") return null;

  const approved = brand.approved.length;
  return (
    <div
      role="status"
      data-testid="blitz-autopilot-banner"
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-border bg-surface-sunken px-4 py-3 text-sm"
    >
      <ZapIcon size={16} aria-hidden="true" />
      <span className="font-medium text-text">
        {approved === 1
          ? tw("autopilot.banner.onOne")
          : tw("autopilot.banner.onMany", { count: approved })}
      </span>
      <span className="text-text-muted">{tw("autopilot.banner.hint")}</span>
      <Link href={STRATEGY_HREF} className="ml-auto text-xs text-accent underline">
        {tw("autopilot.banner.settings")}
      </Link>
    </div>
  );
}
