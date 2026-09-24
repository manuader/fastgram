"use client";

import { Dialog } from "@fastgram/ui";
import { Command } from "cmdk";
import { useRouter } from "next/navigation";
import { useMemo } from "react";
import { BrandAvatar } from "@/components/brands/BrandAvatar";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";
import { paletteLinks } from "@/components/command/palette-items";
import { useTheme } from "@/components/theme/ThemeProvider";
import {
  LayersIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  SearchIcon,
  SunIcon,
  ZapIcon,
  type IconProps,
} from "@/icons";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import type { ThemeChoice } from "@/lib/theme/theme";
import type { ComponentType } from "react";

const THEME_ITEMS: readonly {
  choice: ThemeChoice;
  labelKey: CopyKey;
  icon: ComponentType<IconProps>;
}[] = [
  { choice: "dark", labelKey: "command.themeDark", icon: MoonIcon },
  { choice: "light", labelKey: "command.themeLight", icon: SunIcon },
  { choice: "system", labelKey: "command.themeSystem", icon: MonitorIcon },
];

/**
 * La paleta ⌘K / Ctrl+K · `PU-UI-001` (PLAN §7: "`⌘K` para todo").
 *
 * `cmdk` pone el filtrado difuso y la navegación con flechas; el modal es el
 * `Dialog` de `packages/ui` y no el `Command.Dialog` de cmdk, que trae Radix:
 * así el foco atrapado, Escape y el retorno del foco son los mismos que en el
 * resto de la app.
 *
 * Sólo acciones que existen: ir a una pantalla visible, cambiar de marca,
 * crear una marca, y el tema. "Crear desde prompt" (PLAN §7) no está porque
 * todavía no hay endpoint que lo haga.
 */
export function CommandPalette({
  open,
  onClose,
  isStaff,
  onNewBrand,
}: {
  open: boolean;
  onClose: () => void;
  isStaff: boolean;
  onNewBrand: () => void;
}) {
  const router = useRouter();
  const { theme, setTheme } = useTheme();
  const { mode, isPersonal, workspaces, active, switchTo } = useWorkspace();

  const links = useMemo(() => paletteLinks({ isStaff, mode }), [isStaff, mode]);
  const otherBrands = (workspaces.data ?? []).filter((w) => w.id !== active?.id);

  const run = (action: () => void) => {
    onClose();
    action();
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="md"
      aria-label={tw("command.label")}
      className="fgw-palette"
      overlayClassName="fgw-palette-overlay"
    >
      <Command label={tw("command.label")} className="fgw-palette__command" loop>
        <div className="fgw-palette__search">
          <SearchIcon size={18} />
          <Command.Input
            className="fgw-palette__input"
            placeholder={tw("command.placeholder")}
          />
          <kbd className="fgw-kbd">esc</kbd>
        </div>
        <Command.List className="fgw-palette__list">
          <Command.Empty className="fgw-palette__empty">
            {tw("command.empty")}
          </Command.Empty>

          {isPersonal && (
            <Command.Group heading={tw("command.group.brands")}>
              {otherBrands.map((workspace) => (
                <Command.Item
                  key={workspace.id}
                  value={`brand:${workspace.id}`}
                  keywords={[workspace.name, "brand", "workspace", "switch"]}
                  onSelect={() => {
                    run(() => {
                      switchTo(workspace);
                    });
                  }}
                >
                  <BrandAvatar id={workspace.id} name={workspace.name} size="xs" />
                  <span>{tw("command.switchTo", { name: workspace.name })}</span>
                </Command.Item>
              ))}
              <Command.Item
                value="brand:new"
                keywords={["new brand", "create", "workspace"]}
                onSelect={() => {
                  run(onNewBrand);
                }}
              >
                <PlusIcon size={16} />
                <span>{tw("brands.new")}</span>
              </Command.Item>
              <Command.Item
                value="brand:manage"
                keywords={["manage brands", "rename", "delete", "workspaces"]}
                onSelect={() => {
                  run(() => {
                    router.push(ROUTES.settingsBrands);
                  });
                }}
              >
                <LayersIcon size={16} />
                <span>{tw("brands.manage")}</span>
              </Command.Item>
            </Command.Group>
          )}

          <Command.Group heading={tw("command.group.create")}>
            <Command.Item
              value="create:prompt"
              keywords={[
                "create",
                "prompt",
                "generate",
                "meme",
                "video",
                "idea",
                "blitz",
              ]}
              onSelect={() => {
                run(() => {
                  router.push(`${ROUTES.blitz}#create`);
                });
              }}
            >
              <ZapIcon size={16} />
              <span>{tw("command.createFromPrompt")}</span>
            </Command.Item>
            <Command.Item
              value="create:inspiration"
              keywords={["inspiration", "save", "link", "reference", "remix", "trend"]}
              onSelect={() => {
                run(() => {
                  // `InspirationBoard` abre el diálogo con este ancla.
                  router.push(`${ROUTES.inspiration}#save`);
                });
              }}
            >
              <PlusIcon size={16} />
              <span>{tw("command.saveInspiration")}</span>
            </Command.Item>
          </Command.Group>

          <Command.Group heading={tw("command.group.navigation")}>
            {links.map((link) => {
              const Icon = link.icon;
              return (
                <Command.Item
                  key={link.id}
                  value={link.id}
                  keywords={[link.label, ...link.keywords]}
                  onSelect={() => {
                    run(() => {
                      router.push(link.href);
                    });
                  }}
                >
                  <Icon size={16} />
                  <span>{link.label}</span>
                </Command.Item>
              );
            })}
          </Command.Group>

          <Command.Group heading={tw("command.group.theme")}>
            {THEME_ITEMS.filter((item) => item.choice !== theme).map((item) => {
              const Icon = item.icon;
              return (
                <Command.Item
                  key={item.choice}
                  value={`theme:${item.choice}`}
                  keywords={[tw(item.labelKey), "theme", "toggle", "mode"]}
                  onSelect={() => {
                    run(() => {
                      setTheme(item.choice);
                    });
                  }}
                >
                  <Icon size={16} />
                  <span>{tw(item.labelKey)}</span>
                </Command.Item>
              );
            })}
          </Command.Group>
        </Command.List>
      </Command>
    </Dialog>
  );
}
