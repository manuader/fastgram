/**
 * Qué ofrece la paleta ⌘K · `PU-UI-001`.
 *
 * Separado del componente para poder probarlo sin montar `cmdk`: la regla que
 * importa —"sin acciones que no existan", y lo que D-15 esconde tampoco
 * aparece acá— es lógica pura sobre el modelo del sidebar.
 */
import type { ComponentType } from "react";
import {
  CpuIcon,
  InboxIcon,
  LayersIcon,
  RocketIcon,
  SettingsIcon,
  ZapIcon,
  type IconProps,
} from "@/icons";
import { tw } from "@/lib/i18n/t";
import {
  PRIMARY_NAV,
  SECONDARY_NAV,
  TOOLS_NAV,
  visibleNav,
  type NavVisibility,
} from "@/lib/nav/navigation";
import { ROUTES } from "@/lib/nav/routes";

export interface PaletteLink {
  readonly id: string;
  readonly label: string;
  readonly href: string;
  readonly icon: ComponentType<IconProps>;
  readonly keywords: readonly string[];
}

/**
 * Las pantallas a las que se puede saltar: el sidebar visible (sin enlaces
 * externos: la paleta navega dentro de la app) más las subpantallas que no
 * tienen entrada propia en el sidebar (Blitz Settings y las secciones de
 * Settings).
 */
export function paletteLinks(visibility: NavVisibility): PaletteLink[] {
  const fromNav = [PRIMARY_NAV, TOOLS_NAV, SECONDARY_NAV].flatMap((group) =>
    visibleNav(group, visibility)
      .filter((item) => item.external !== true)
      .map<PaletteLink>((item) => ({
        id: `nav:${item.id}`,
        label: tw(item.labelKey),
        href: item.href,
        icon: item.icon,
        keywords: [item.id],
      })),
  );
  const settings = tw("nav.settings");
  const extras: PaletteLink[] = [
    {
      id: "nav:blitz-settings",
      label: `${tw("nav.blitz")} › ${settings}`,
      href: ROUTES.blitzSettings,
      icon: RocketIcon,
      keywords: ["preferences", "weights"],
    },
    {
      id: "nav:settings-brands",
      label: `${settings} › ${tw("settings.nav.brands")}`,
      href: ROUTES.settingsBrands,
      icon: LayersIcon,
      keywords: ["workspaces", "brands"],
    },
    {
      id: "nav:settings-models",
      label: `${settings} › ${tw("settings.nav.models")}`,
      href: ROUTES.settingsModels,
      icon: CpuIcon,
      keywords: ["ai", "providers", "models"],
    },
    // Sprint 7: el resto de las secciones del hub de Settings.
    {
      id: "nav:settings-strategy",
      label: `${settings} › ${tw("settings.nav.strategy")}`,
      href: ROUTES.settingsStrategy,
      icon: ZapIcon,
      keywords: ["autopilot", "schedule", "frequency"],
    },
    {
      id: "nav:settings-connections",
      label: `${settings} › ${tw("settings.nav.connections")}`,
      href: ROUTES.settingsConnections,
      icon: LayersIcon,
      keywords: ["accounts", "reconnect", "instagram", "tiktok"],
    },
    {
      id: "nav:settings-integrations",
      label: `${settings} › ${tw("settings.nav.integrations")}`,
      href: ROUTES.settingsIntegrations,
      icon: SettingsIcon,
      keywords: ["apps", "oauth", "client id"],
    },
    {
      id: "nav:settings-notifications",
      label: `${settings} › Notifications`,
      href: ROUTES.settingsNotifications,
      icon: InboxIcon,
      keywords: ["alerts", "ntfy", "telegram", "push"],
    },
  ];
  return [...fromNav, ...extras];
}
