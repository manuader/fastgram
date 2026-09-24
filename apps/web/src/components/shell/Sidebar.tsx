"use client";

import { Tooltip } from "@fastgram/ui";
import { BrandSwitcher } from "@/components/brands/BrandSwitcher";
import { ShortcutHint } from "@/components/command/ShortcutHint";
import { useShellActions } from "@/components/shell/ShellActions";
import { SidebarBody } from "@/components/shell/SidebarBody";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { PanelLeftIcon, SearchIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";

interface SidebarProps {
  pathname: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  isStaff: boolean;
  attention?: ReadonlySet<string>;
}

/**
 * Riel lateral de escritorio y tablet · `P1-UI-003` / `FR-001`, rediseñado en
 * `PU-UI-001`.
 *
 * Arriba de todo, **la marca activa** (el selector es el primer elemento, PLAN
 * §7); debajo, la entrada a la paleta ⌘K; los bloques de navegación; y abajo
 * el tema y el botón de colapsar.
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
  const { openPalette } = useShellActions();
  const searchLabel = tw("nav.searchShortcut");

  const search = (
    <button
      type="button"
      className="fgw-sidebar__search fg-focusable"
      onClick={openPalette}
      aria-label={collapsed ? searchLabel : undefined}
      aria-keyshortcuts="Meta+K Control+K"
    >
      <SearchIcon size={16} />
      {!collapsed && (
        <>
          <span className="fgw-sidebar__search-label">{searchLabel}</span>
          <ShortcutHint />
        </>
      )}
    </button>
  );

  return (
    <aside
      className="fgw-sidebar"
      data-collapsed={collapsed ? "true" : "false"}
      aria-label={tw("nav.menu")}
    >
      <div className="fgw-sidebar__header">
        <BrandSwitcher collapsed={collapsed} />
      </div>

      {collapsed ? (
        <Tooltip content={searchLabel} side="right">
          {search}
        </Tooltip>
      ) : (
        search
      )}

      <SidebarBody
        pathname={pathname}
        collapsed={collapsed}
        isStaff={isStaff}
        scope="rail"
        {...(attention === undefined ? {} : { attention })}
      />

      <div className="fgw-sidebar__footer">
        <ThemeToggle />
        <button
          type="button"
          className="fgw-sidebar__collapse fg-focusable"
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          aria-label={collapsed ? tw("nav.expand") : tw("nav.collapse")}
          title={collapsed ? tw("nav.expand") : tw("nav.collapse")}
        >
          <PanelLeftIcon size={18} />
        </button>
      </div>
    </aside>
  );
}
