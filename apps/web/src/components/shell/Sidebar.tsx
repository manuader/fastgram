"use client";

import Link from "next/link";
import { SidebarBody } from "@/components/shell/SidebarBody";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { PanelLeftIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";

interface SidebarProps {
  pathname: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  isStaff: boolean;
  attention?: ReadonlySet<string>;
}

/**
 * Riel lateral de escritorio y tablet · `P1-UI-003` / `FR-001`.
 *
 * Encabezado con el logotipo y el botón de colapsar (PRD:293), los dos bloques
 * de navegación, y abajo el selector de tema.
 *
 * `aria-expanded` en el botón, y el `<aside>` con `data-collapsed`: el estado
 * lo dice el atributo, no sólo el ancho en píxeles.
 */
export function Sidebar({
  pathname,
  collapsed,
  onToggleCollapsed,
  isStaff,
  attention,
}: SidebarProps) {
  return (
    <aside
      className="fgw-sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      aria-label={tw("nav.menu")}
    >
      <div className="fgw-sidebar__header">
        <Link href={ROUTES.home} className="fgw-brand fg-focusable">
          <span className="fgw-brand__mark" aria-hidden="true">
            FG
          </span>
          <span className={collapsed ? "fg-visually-hidden" : "fgw-brand__name"}>
            FastGram
          </span>
        </Link>
        <button
          type="button"
          className="fgw-sidebar__collapse fg-focusable"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? tw("nav.expand") : tw("nav.collapse")}
        >
          <PanelLeftIcon size={18} />
        </button>
      </div>

      <SidebarBody
        pathname={pathname}
        collapsed={collapsed}
        isStaff={isStaff}
        {...(attention === undefined ? {} : { attention })}
      />

      <div className="fgw-sidebar__footer">
        <ThemeToggle />
      </div>
    </aside>
  );
}
