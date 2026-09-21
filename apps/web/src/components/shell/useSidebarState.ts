"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * Estado del sidebar · `P1-UI-003` + `P1-UI-008`.
 *
 * Tres tamaños, no dos (`NFR-019`):
 *
 *   · **móvil** (< 768px) → no hay sidebar fijo; es un drawer que se abre.
 *   · **tablet** (768–1279px) → sidebar en modo icono por defecto. A ese ancho,
 *     248px de nav se comen la pantalla en la que hay que trabajar.
 *   · **escritorio** (≥ 1280px) → expandido por defecto.
 *
 * Los defaults son defaults: en cuanto el usuario pulsa el botón de colapsar, su
 * elección se guarda y gana sobre el ancho. Reabrir la app y encontrarse el
 * sidebar como uno **no** lo dejó es de las cosas que más se notan.
 */

const STORAGE_KEY = "fg-sidebar-collapsed";
const MOBILE_QUERY = "(max-width: 767px)";
const COMPACT_QUERY = "(max-width: 1279px)";

export interface SidebarState {
  /** `true` sólo en móvil: el nav vive en un drawer. */
  isMobile: boolean;
  /** Sidebar en modo icono. Sin sentido en móvil. */
  collapsed: boolean;
  toggleCollapsed: () => void;
  drawerOpen: boolean;
  openDrawer: () => void;
  closeDrawer: () => void;
  /**
   * `false` hasta el primer efecto. El servidor no conoce el ancho de la
   * ventana: hasta saberlo se renderiza el layout de escritorio y se deja que
   * el CSS tape el hueco, en vez de adivinar y provocar un salto.
   */
  hydrated: boolean;
}

function readStoredCollapsed(): boolean | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "true") return true;
    if (raw === "false") return false;
    return null;
  } catch {
    return null;
  }
}

function storeCollapsed(value: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, value ? "true" : "false");
  } catch {
    /* almacenamiento bloqueado: vale para esta pestaña. */
  }
}

export function useSidebarState(): SidebarState {
  const [isMobile, setIsMobile] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const mobile = window.matchMedia(MOBILE_QUERY);
    const compact = window.matchMedia(COMPACT_QUERY);

    const sync = (): void => {
      setIsMobile(mobile.matches);
      const stored = readStoredCollapsed();
      setCollapsed(stored ?? compact.matches);
    };

    sync();
    setHydrated(true);
    mobile.addEventListener("change", sync);
    compact.addEventListener("change", sync);
    return () => {
      mobile.removeEventListener("change", sync);
      compact.removeEventListener("change", sync);
    };
  }, []);

  // El drawer no puede sobrevivir a un giro de pantalla: en escritorio no hay
  // nada que cerrar y el overlay se quedaría bloqueando el scroll.
  useEffect(() => {
    if (!isMobile) setDrawerOpen(false);
  }, [isMobile]);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((current) => {
      storeCollapsed(!current);
      return !current;
    });
  }, []);

  const openDrawer = useCallback(() => {
    setDrawerOpen(true);
  }, []);
  const closeDrawer = useCallback(() => {
    setDrawerOpen(false);
  }, []);

  return {
    isMobile,
    collapsed,
    toggleCollapsed,
    drawerOpen,
    openDrawer,
    closeDrawer,
    hydrated,
  };
}
