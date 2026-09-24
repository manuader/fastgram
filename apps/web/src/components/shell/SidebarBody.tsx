"use client";

import { LayoutGroup } from "motion/react";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";
import { SidebarNav } from "@/components/shell/SidebarNav";
import { tw } from "@/lib/i18n/t";
import { PRIMARY_NAV, SECONDARY_NAV, TOOLS_NAV, visibleNav } from "@/lib/nav/navigation";

interface SidebarBodyProps {
  pathname: string;
  collapsed: boolean;
  isStaff: boolean;
  attention?: ReadonlySet<string>;
  onNavigate?: () => void;
  /** Namespace del resalte animado: `rail` o `drawer` (ver `SidebarNav`). */
  scope: string;
}

/**
 * Los bloques del sidebar: el circuito diario, las herramientas y, abajo, el
 * bloque con `Settings` (`lib/nav/navigation.ts`).
 *
 * Está separado del contenedor porque el mismo contenido va en dos sitios: el
 * riel de escritorio y el drawer de móvil (`NFR-019`). Duplicarlo sería
 * garantizar que un día el móvil pierde una entrada.
 */
export function SidebarBody({
  pathname,
  collapsed,
  isStaff,
  attention,
  onNavigate,
  scope,
}: SidebarBodyProps) {
  const { mode } = useWorkspace();
  const visibility = { isStaff, mode };
  const shared = {
    pathname,
    collapsed,
    ...(attention === undefined ? {} : { attention }),
    ...(onNavigate === undefined ? {} : { onNavigate }),
  };

  return (
    <LayoutGroup id={scope}>
      <div className="fgw-sidebar__body">
        <SidebarNav
          items={visibleNav(PRIMARY_NAV, visibility)}
          label={tw("nav.primaryLabel")}
          {...shared}
        />
        <hr className="fgw-sidebar__separator" />
        <SidebarNav
          items={visibleNav(TOOLS_NAV, visibility)}
          label={tw("nav.toolsLabel")}
          {...shared}
        />
        <SidebarNav
          items={visibleNav(SECONDARY_NAV, visibility)}
          label={tw("nav.footerLabel")}
          {...shared}
        />
      </div>
    </LayoutGroup>
  );
}
