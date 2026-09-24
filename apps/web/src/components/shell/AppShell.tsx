"use client";

import { Drawer, DrawerBody, DrawerClose, DrawerHeader, DrawerTitle } from "@fastgram/ui";
import { MotionConfig } from "motion/react";
import { usePathname } from "next/navigation";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { BrandSwitcher } from "@/components/brands/BrandSwitcher";
import { NewBrandDialog } from "@/components/brands/NewBrandDialog";
import { useWorkspace, WorkspaceProvider } from "@/components/brands/WorkspaceProvider";
import { CommandPalette } from "@/components/command/CommandPalette";
import { ConnectionBanner } from "@/components/notifications/ConnectionBanner";
import { NotificationBell } from "@/components/notifications/NotificationBell";
import { usePaletteHotkey } from "@/components/command/use-palette-hotkey";
import { ShellActionsProvider, type ShellActions } from "@/components/shell/ShellActions";
import { Sidebar } from "@/components/shell/Sidebar";
import { SidebarBody } from "@/components/shell/SidebarBody";
import { SupportBubble } from "@/components/shell/SupportBubble";
import { useSidebarState } from "@/components/shell/useSidebarState";
import { ThemeToggle } from "@/components/theme/ThemeToggle";
import { MenuIcon, SearchIcon } from "@/icons";
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
 * La shell: sidebar + contenido + burbuja de soporte, más lo global de
 * `PU-UI-001`: la marca activa (`WorkspaceProvider`), la paleta ⌘K y el
 * diálogo de "New brand".
 *
 * `MotionConfig reducedMotion="user"`: toda animación de `motion` dentro de la
 * shell respeta `prefers-reduced-motion` sin que cada componente lo mire.
 *
 * **Responsive de verdad** (`P1-UI-008`, `NFR-019`): por debajo de 768px el
 * riel desaparece y la navegación entra en un `Drawer` de `packages/ui`, que
 * ya trae foco atrapado, cierre con Escape y bloqueo del scroll. El drawer se
 * cierra al navegar: si no, quien toca `Calendar` en el móvil ve el
 * calendario tapado por el menú que acaba de usar.
 */
export function AppShell(props: AppShellProps) {
  return (
    <MotionConfig reducedMotion="user">
      <WorkspaceProvider>
        <ShellFrame {...props} />
      </WorkspaceProvider>
    </MotionConfig>
  );
}

function ShellFrame({ children, isStaff, attention }: AppShellProps) {
  const pathname = usePathname();
  const sidebar = useSidebarState();
  const { isPersonal, mode } = useWorkspace();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [newBrandOpen, setNewBrandOpen] = useState(false);

  const openPalette = useCallback(() => {
    setPaletteOpen(true);
  }, []);
  const closePalette = useCallback(() => {
    setPaletteOpen(false);
  }, []);
  const togglePalette = useCallback(() => {
    // Con otro modal abierto (New brand) el atajo no apila una paleta encima.
    if (newBrandOpen) return;
    setPaletteOpen((current) => !current);
  }, [newBrandOpen]);
  const openNewBrand = useCallback(() => {
    setPaletteOpen(false);
    setNewBrandOpen(true);
  }, []);
  const closeNewBrand = useCallback(() => {
    setNewBrandOpen(false);
  }, []);

  usePaletteHotkey(togglePalette);

  const actions = useMemo<ShellActions>(
    () => ({ openPalette, openNewBrand }),
    [openPalette, openNewBrand],
  );

  return (
    <ShellActionsProvider value={actions}>
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
              <button
                type="button"
                className="fgw-topbar__menu fg-focusable"
                onClick={openPalette}
                aria-label={tw("nav.searchShortcut")}
              >
                <SearchIcon size={20} />
              </button>
              <NotificationBell className="fgw-topbar__menu" />
              <ThemeToggle />
            </div>
          </header>

          <main id="main" className="fgw-content">
            {/* Sprint 7: conexiones vencidas o por vencer, en todas las pantallas. */}
            <ConnectionBanner />
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
            {isPersonal && (
              <div className="fgw-drawer-brand">
                <BrandSwitcher collapsed={false} onNavigate={sidebar.closeDrawer} />
              </div>
            )}
            <SidebarBody
              pathname={pathname}
              collapsed={false}
              isStaff={isStaff}
              scope="drawer"
              onNavigate={sidebar.closeDrawer}
              {...(attention === undefined ? {} : { attention })}
            />
          </DrawerBody>
        </Drawer>

        <CommandPalette
          open={paletteOpen}
          onClose={closePalette}
          isStaff={isStaff}
          onNewBrand={openNewBrand}
        />
        <NewBrandDialog open={newBrandOpen} onClose={closeNewBrand} />

        {/* Sprint 7: la burbuja no abre nada (no hay proveedor de soporte); en el
            modo personal no tiene a quién llamar. Mismo criterio que D-15 en el
            sidebar: mientras el modo no se sabe, tampoco. */}
        {mode === "standard" && <SupportBubble />}
      </div>
    </ShellActionsProvider>
  );
}
