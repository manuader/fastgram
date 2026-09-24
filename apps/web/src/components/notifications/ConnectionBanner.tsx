"use client";

import type { ConnectionAlert } from "@fastgram/contracts";
import { buttonVariants } from "@fastgram/ui";
import Link from "next/link";
import { useState } from "react";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";
import { ROUTES } from "@/lib/nav/routes";
import { useConnectionAlerts } from "./api";
import { NOTIFICATIONS_COPY as C, PLATFORM_NAME } from "./copy";

const DAY_FORMAT: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" };

export function alertText(alert: ConnectionAlert): string {
  const platform = PLATFORM_NAME[alert.platform] ?? alert.platform;
  if (alert.state === "expired") {
    return C.bannerExpired(platform, alert.account, alert.workspaceName);
  }
  const day =
    alert.deadline === null
      ? ""
      : new Date(alert.deadline).toLocaleDateString("en-US", DAY_FORMAT);
  return C.bannerExpiring(platform, alert.account, alert.workspaceName, day);
}

/**
 * Banner global de conexiones — PRD §13.2 N-09/N-10/N-11, `P3-OAUTH-005/011`
 * (sprint 7). Arriba del contenido, en todas las pantallas: la primera
 * conexión con problema (las vencidas primero) y cuántas más hay.
 *
 * - Vencida → rojo, **Reconnect** (va a Settings → Connections de esa marca).
 * - Por vencer (≤7 días) → amarillo, con la fecha; se puede descartar hasta
 *   que recargue la página (una vencida no: es la que frena las publicaciones).
 *
 * Sin datos, cargando o con error, **no muestra nada**: el banner es un aviso
 * extra, y un error acá no tiene que tapar la pantalla que el usuario abrió
 * (la campana y Settings → Connections muestran el suyo).
 */
export function ConnectionBanner() {
  const alerts = useConnectionAlerts();
  const { workspaces, active, switchTo } = useWorkspace();
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());

  const visible = (alerts.data?.alerts ?? []).filter(
    (a) => a.state === "expired" || !dismissed.has(a.connectionId),
  );
  const first = visible[0];
  if (first === undefined) return null;
  const expired = first.state === "expired";

  const goToBrand = () => {
    if (active !== null && first.workspaceId !== active.id) {
      const target = workspaces.data?.find((w) => w.id === first.workspaceId);
      if (target !== undefined) switchTo(target, { silent: true });
    }
  };

  return (
    <div
      role={expired ? "alert" : "status"}
      className={`mb-4 flex flex-wrap items-center gap-3 rounded-md border p-3 text-sm ${
        expired ? "border-danger text-danger" : "border-warning text-warning"
      } bg-surface`}
    >
      <span className="min-w-0 flex-1 text-text">
        {alertText(first)}
        {visible.length > 1 && (
          <span className="ml-2 text-text-muted">{C.bannerMore(visible.length - 1)}</span>
        )}
      </span>
      <Link
        href={ROUTES.settingsConnections}
        onClick={goToBrand}
        className={buttonVariants({ variant: "secondary", size: "sm" })}
      >
        {C.reconnect}
      </Link>
      {!expired && (
        <button
          type="button"
          className="fg-focusable text-text-muted underline-offset-2 hover:underline"
          onClick={() => setDismissed(new Set([...dismissed, first.connectionId]))}
        >
          {C.dismiss}
        </button>
      )}
    </div>
  );
}
