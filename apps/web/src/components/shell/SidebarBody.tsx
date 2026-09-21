"use client";

import { SidebarNav } from "@/components/shell/SidebarNav";
import { tw } from "@/lib/i18n/t";
import { PRIMARY_NAV, visibleSecondaryNav } from "@/lib/nav/navigation";

interface SidebarBodyProps {
  pathname: string;
  collapsed: boolean;
  isStaff: boolean;
  attention?: ReadonlySet<string>;
  onNavigate?: () => void;
}

/**
 * Los dos bloques del sidebar (PRD:293-338).
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
}: SidebarBodyProps) {
  return (
    <div className="fgw-sidebar__body">
      <SidebarNav
        items={PRIMARY_NAV}
        pathname={pathname}
        collapsed={collapsed}
        label={tw("nav.primaryLabel")}
        {...(attention === undefined ? {} : { attention })}
        {...(onNavigate === undefined ? {} : { onNavigate })}
      />
      <hr className="fgw-sidebar__separator" />
      <SidebarNav
        items={visibleSecondaryNav(isStaff)}
        pathname={pathname}
        collapsed={collapsed}
        label={tw("nav.secondaryLabel")}
        {...(attention === undefined ? {} : { attention })}
        {...(onNavigate === undefined ? {} : { onNavigate })}
      />
    </div>
  );
}
