"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { DEFAULT_THEME, readThemeChoice } from "@/components/theme/default-theme";
import { applyTheme, storeTheme, type ThemeChoice } from "@/lib/theme/theme";

interface ThemeContextValue {
  theme: ThemeChoice;
  setTheme: (choice: ThemeChoice) => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Estado del tema para la UI que lo enseña (el selector).
 *
 * **No es quien evita el flash** — eso ya lo hizo `ThemeScript` antes de que
 * este componente existiera. Este provider sólo mantiene sincronizados el
 * `localStorage`, el atributo del `<html>` y el control que lo muestra.
 *
 * Arranca en el default (`dark`, `default-theme.ts`) en servidor y en
 * cliente, y lee el valor real en un efecto. Si leyera `localStorage` durante el render, el HTML del servidor y el
 * del cliente discreparían y React tiraría el árbol entero.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeChoice>(DEFAULT_THEME);

  useEffect(() => {
    setThemeState(readThemeChoice());
  }, []);

  const setTheme = useCallback((choice: ThemeChoice) => {
    setThemeState(choice);
    storeTheme(choice);
    applyTheme(document.documentElement, choice);
  }, []);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, setTheme }),
    [theme, setTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (context === null) {
    throw new Error("useTheme() necesita un <ThemeProvider> por encima.");
  }
  return context;
}
