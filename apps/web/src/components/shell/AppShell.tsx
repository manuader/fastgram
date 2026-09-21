"use client";

import { Drawer, DrawerBody, DrawerClose, DrawerHeader, DrawerTitle } from "@fastgram/ui";
import { usePathname } from "next/navigation";
import { type ReactNode } from "react";
import { Sidebar } from "@/components/shell/Sidebar";
import { SidebarBody } from "@/components/shell/SidebarBody";
import { SupportBubble } from "@/components/shell/SupportBubble";
import { useSidebarState } from "@/components/shell/useSidebarState";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { MenuIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";

export interface AppShellProps {
  children: ReactNode;
  /** PRD:329 — decide si la entrada `Admin` existe siquiera. */
  isStaff: boolean;
  /**
   * Entradas con punto rojo pendiente (PRD:338). Hoy llega vacío: el estado que
   * lo alimenta —una integración caída, §19.5— es de `apps/api` y todavía no
   * hay endpoint. Llega como prop y no como `useState` interno para que el día
   * que exista sólo cambie quién lo pasa.
   */
  attention?: ReadonlySet<string>;
}

/**
 * La shell: sidebar + contenido + burbuja de soporte.
 *
 * **Responsive de verdad** (`P1-UI-008`, `NFR-019`): por debajo de 768px el
 * riel desaparece y la navegación entra en un `Drawer` de `packages/ui`, que
 * ya trae foco atrapado, cierre con Escape y bloqueo del scroll. Reimplementar
 * eso aquí sería repetir la parte difícil.
 *
 * El drawer se cierra al navegar. Si no, quien toca `Calendar` en el móvil ve
 * el calendario tapado por el menú que acaba de usar.
 */
export function AppShell({ children, isStaff, attention }: AppShellProps) {
  const pathname = usePathname();
  const sidebar = useSidebarState();

  return (
    <div
      className="fgw-shell"
      data-collapsed={sidebar.collapsed ? "true" : "false"}
      // Hasta que el primer efecto mide la ventana, el CSS apaga la transición
      // de ancho: si no, al cargar en tablet el sidebar se ve encogerse.
      data-ready={sidebar.hydrated ? "true" : "false"}
    >
      <Sidebar
        pathname={pathname}
        collapsed={sidebar.collapsed}
        onToggleCollapsed={sidebar.toggleCollapsed}
        isStaff={isStaff}
        {...(attention === undefined ? {} : { attention })}
      />

      <div className="fgw-shell__main">
        <header className="fgw-topbar">
          <button
            type="button"
            className="fgw-topbar__menu fg-focusable"
            onClick={sidebar.openDrawer}
            aria-label={tw("nav.openMenu")}
            aria-expanded={sidebar.drawerOpen}
          >
            <MenuIcon size={20} />
          </button>
          <span className="fgw-topbar__brand">FastGram</span>
          <div className="fgw-topbar__actions">
            <ThemeToggle />
          </div>
        </header>

        <main id="main" className="fgw-content">
          {children}
        </main>
      </div>

      <Drawer
        open={sidebar.drawerOpen}
        onClose={sidebar.closeDrawer}
        side="left"
        size="sm"
      >
        <DrawerHeader>
          <DrawerTitle>{tw("nav.menu")}</DrawerTitle>
          <DrawerClose label={tw("nav.closeMenu")} />
        </DrawerHeader>
        <DrawerBody>
          <SidebarBody
            pathname={pathname}
            collapsed={false}
            isStaff={isStaff}
            onNavigate={sidebar.closeDrawer}
            {...(attention === undefined ? {} : { attention })}
          />
        </DrawerBody>
      </Drawer>

      <SupportBubble />
    </div>
  );
}
