"use client";

import {
  createContext,
  useContext,
  useId,
  useRef,
  useState,
  type ComponentPropsWithRef,
  type ReactNode,
} from "react";
import { cn } from "../../cn";
import { nextRovingIndex, type Orientation } from "../../lib/roving";

interface TabsContextValue {
  value: string;
  setValue: (value: string) => void;
  baseId: string;
  orientation: Orientation;
}

const TabsContext = createContext<TabsContextValue | null>(null);

function useTabsContext(component: string): TabsContextValue {
  const context = useContext(TabsContext);
  if (context === null) {
    throw new Error(`<${component}> tiene que estar dentro de <Tabs>.`);
  }
  return context;
}

export interface TabsProps extends Omit<ComponentPropsWithRef<"div">, "onChange"> {
  /** Pestaña activa en modo controlado. */
  value?: string;
  defaultValue: string;
  onValueChange?: (value: string) => void;
  orientation?: Orientation;
  children?: ReactNode;
}

/**
 * Pestañas (Library: `My Posts` · `My Content` · `My Media Bank`; Influencer:
 * `Images` · `Videos` · `Configuration`).
 *
 * Implementa el patrón tablist de WAI-ARIA: las flechas mueven entre pestañas,
 * Home/End van a los extremos, y **una sola pestaña está en el orden de
 * tabulación** (roving tabindex), así que Tab salta al contenido en vez de
 * recorrer las pestañas una por una.
 *
 * Activación automática: mover el foco cambia de pestaña. Es lo correcto cuando
 * el panel se pinta al instante. Si un panel tarda en cargar, el patrón que
 * corresponde es activación manual (Enter/Espacio) y hoy no está implementado.
 */
export function Tabs({
  value,
  defaultValue,
  onValueChange,
  orientation = "horizontal",
  className,
  children,
  ...props
}: TabsProps) {
  const baseId = useId();
  const [internal, setInternal] = useState(defaultValue);
  const isControlled = value !== undefined;
  const current = isControlled ? value : internal;

  function setValue(next: string): void {
    if (!isControlled) setInternal(next);
    onValueChange?.(next);
  }

  return (
    <TabsContext.Provider value={{ value: current, setValue, baseId, orientation }}>
      <div
        {...props}
        className={cn("fg-tabs", `fg-tabs--${orientation}`, className)}
        data-orientation={orientation}
      >
        {children}
      </div>
    </TabsContext.Provider>
  );
}

export function TabsList({
  className,
  onKeyDown,
  ...props
}: ComponentPropsWithRef<"div">) {
  const { orientation } = useTabsContext("TabsList");
  const listRef = useRef<HTMLDivElement | null>(null);

  return (
    <div
      {...props}
      ref={listRef}
      role="tablist"
      aria-orientation={orientation}
      className={cn("fg-tabs__list", className)}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        if (event.defaultPrevented) return;

        const list = listRef.current;
        if (list === null) return;
        const tabs = Array.from(
          list.querySelectorAll<HTMLButtonElement>('[role="tab"]:not([disabled])'),
        );
        const active = document.activeElement;
        const currentIndex = tabs.findIndex((tab) => tab === active);
        if (currentIndex === -1) return;

        const next = nextRovingIndex({
          current: currentIndex,
          count: tabs.length,
          key: event.key,
          orientation,
        });
        if (next === null) return;
        event.preventDefault();
        // Activación automática: enfocar dispara el click, que cambia de panel.
        tabs[next]?.focus();
        tabs[next]?.click();
      }}
    />
  );
}

export interface TabsTriggerProps extends Omit<ComponentPropsWithRef<"button">, "value"> {
  value: string;
}

export function TabsTrigger({
  value,
  className,
  onClick,
  disabled,
  ...props
}: TabsTriggerProps) {
  const context = useTabsContext("TabsTrigger");
  const selected = context.value === value;

  return (
    <button
      {...props}
      type="button"
      role="tab"
      id={tabId(context.baseId, value)}
      aria-selected={selected}
      aria-controls={panelId(context.baseId, value)}
      tabIndex={selected ? 0 : -1}
      disabled={disabled}
      data-state={selected ? "active" : "inactive"}
      className={cn("fg-tab", className)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        context.setValue(value);
      }}
    />
  );
}

export interface TabsContentProps extends ComponentPropsWithRef<"div"> {
  value: string;
}

export function TabsContent({ value, className, ...props }: TabsContentProps) {
  const context = useTabsContext("TabsContent");
  const selected = context.value === value;

  return (
    <div
      {...props}
      role="tabpanel"
      id={panelId(context.baseId, value)}
      aria-labelledby={tabId(context.baseId, value)}
      hidden={!selected}
      // El panel es enfocable para que Tab desde la pestaña caiga dentro del
      // contenido aunque el panel no empiece con un control.
      tabIndex={selected ? 0 : -1}
      className={cn("fg-tabs__panel", className)}
    />
  );
}

function tabId(baseId: string, value: string): string {
  return `${baseId}-tab-${value}`;
}

function panelId(baseId: string, value: string): string {
  return `${baseId}-panel-${value}`;
}
