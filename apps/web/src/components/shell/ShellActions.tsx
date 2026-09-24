"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Acciones globales de la shell que se disparan desde varios sitios: el
 * selector de marca, la paleta ⌘K y la página de marcas abren **el mismo**
 * diálogo de "New brand"; el botón de búsqueda y el atajo abren la misma
 * paleta. Un contexto chico evita pasar callbacks por cinco niveles.
 */
export interface ShellActions {
  openPalette: () => void;
  openNewBrand: () => void;
}

const ShellActionsContext = createContext<ShellActions | null>(null);

export function ShellActionsProvider({
  value,
  children,
}: {
  value: ShellActions;
  children: ReactNode;
}) {
  return (
    <ShellActionsContext.Provider value={value}>{children}</ShellActionsContext.Provider>
  );
}

export function useShellActions(): ShellActions {
  const context = useContext(ShellActionsContext);
  if (context === null) {
    throw new Error("useShellActions() necesita la <AppShell> por encima.");
  }
  return context;
}
