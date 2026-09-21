"use client";

import { useTheme } from "@/components/theme/ThemeProvider";
import { MonitorIcon, MoonIcon, SunIcon, type IconProps } from "@/icons";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { THEME_CHOICES, type ThemeChoice } from "@/lib/theme/theme";
import type { ComponentType } from "react";

const OPTIONS: Readonly<
  Record<ThemeChoice, { labelKey: CopyKey; icon: ComponentType<IconProps> }>
> = {
  light: { labelKey: "theme.light", icon: SunIcon },
  dark: { labelKey: "theme.dark", icon: MoonIcon },
  system: { labelKey: "theme.system", icon: MonitorIcon },
};

/**
 * Selector de tema: tres botones, no un interruptor de dos.
 *
 * `system` no es un estado intermedio entre claro y oscuro, es una tercera
 * opción —"seguí a mi sistema operativo"— y un toggle de dos posiciones no
 * puede representarla. Se pierde al usuario que tiene el SO en automático.
 *
 * Botones con `aria-pressed` en vez de radios: no es un dato de un formulario,
 * es una acción inmediata. Tab entra y sale del grupo con el orden natural.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();

  return (
    <div
      className={
        className === undefined ? "fgw-theme-toggle" : `fgw-theme-toggle ${className}`
      }
      role="group"
      aria-label={tw("theme.label")}
    >
      {THEME_CHOICES.map((choice) => {
        const option = OPTIONS[choice];
        const Icon = option.icon;
        const label = tw(option.labelKey);
        const selected = theme === choice;
        return (
          <button
            key={choice}
            type="button"
            className="fgw-theme-toggle__button fg-focusable"
            aria-pressed={selected}
            data-selected={selected ? "true" : undefined}
            title={label}
            onClick={() => {
              setTheme(choice);
            }}
          >
            <Icon size={16} />
            <span className="fg-visually-hidden">{label}</span>
          </button>
        );
      })}
    </div>
  );
}
