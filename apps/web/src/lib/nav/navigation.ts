/**
 * Modelo del sidebar · `P1-UI-003` / `FR-001`. PRD §3.2 (PRD:293-338).
 *
 * El orden **es** especificación, no gusto: el PRD lo marca "orden exacto" y
 * está CONFIRMED contra el producto original. No se reordena sin tocar el PRD.
 *
 * Los labels salen del catálogo de copy por clave (`nav.*`), no escritos aquí:
 * es la regla de i18n del proyecto, y además es lo que permite que el tooltip
 * del estado colapsado y el label del expandido no puedan divergir.
 */
import type { ComponentType } from "react";
import {
  BarChartIcon,
  BriefcaseIcon,
  CalendarIcon,
  ClapperboardIcon,
  DiscordIcon,
  GiftIcon,
  HomeIcon,
  LibraryIcon,
  MapIcon,
  MessageSquareIcon,
  RocketIcon,
  SettingsIcon,
  ShieldIcon,
  UserIcon,
  UsersIcon,
  UsersRoundIcon,
  WandIcon,
  type IconProps,
} from "@/icons";
import type { CopyKey } from "../i18n/t";
import { DISCORD_INVITE_URL, ROUTES } from "./routes";

export interface NavItem {
  readonly id: string;
  readonly labelKey: CopyKey;
  readonly href: string;
  readonly icon: ComponentType<IconProps>;
  /** Enlace fuera de la app: abre en pestaña nueva y lleva su icono. */
  readonly external?: boolean;
  /** PRD:329 — `Admin` sólo para staff. */
  readonly staffOnly?: boolean;
  /**
   * PRD:338 — `Settings` lleva **indicador de punto rojo** cuando hay acción
   * pendiente. Sólo marca quién puede llevarlo; si hoy lo lleva o no es estado,
   * no configuración.
   */
  readonly canShowAttentionDot?: boolean;
}

/** PRD:295-306 — las 10 entradas, en el orden exacto del PRD. */
export const PRIMARY_NAV: readonly NavItem[] = [
  { id: "home", labelKey: "nav.home", href: ROUTES.home, icon: HomeIcon },
  {
    id: "engagement",
    labelKey: "nav.engagement",
    href: ROUTES.engagement,
    icon: UsersIcon,
  },
  { id: "blitz", labelKey: "nav.blitz", href: ROUTES.blitz, icon: RocketIcon },
  { id: "ai-studio", labelKey: "nav.aiStudio", href: ROUTES.aiStudio, icon: WandIcon },
  {
    id: "influencers",
    labelKey: "nav.influencers",
    href: ROUTES.influencers,
    icon: UserIcon,
  },
  {
    id: "content",
    labelKey: "nav.content",
    href: ROUTES.content,
    icon: ClapperboardIcon,
  },
  { id: "library", labelKey: "nav.library", href: ROUTES.library, icon: LibraryIcon },
  {
    id: "calendar",
    labelKey: "nav.calendar",
    href: ROUTES.calendar,
    icon: CalendarIcon,
  },
  {
    id: "analytics",
    labelKey: "nav.analytics",
    href: ROUTES.analytics,
    icon: BarChartIcon,
  },
  {
    id: "warmed-accounts",
    labelKey: "nav.warmedAccounts",
    href: ROUTES.warmedAccounts,
    icon: UsersRoundIcon,
  },
];

/**
 * PRD:308-338 — el bloque secundario, separado y abajo.
 *
 * `Admin` está en la lista con `staffOnly` en vez de borrado: el PRD dice
 * "omitir en el clon **o** gatear por rol", y gatear deja constancia de que la
 * entrada existe en el producto original. Su `href` apunta a `/admin`, que
 * **no está implementado** (PRD §2.5: fuera de alcance); con `isStaff: false`
 * —que es lo que devuelve hoy la sesión— nunca se pinta.
 */
export const SECONDARY_NAV: readonly NavItem[] = [
  {
    id: "admin",
    labelKey: "nav.admin",
    href: "/admin",
    icon: ShieldIcon,
    staffOnly: true,
  },
  {
    id: "refer-and-earn",
    labelKey: "nav.referAndEarn",
    href: ROUTES.referAndEarn,
    icon: GiftIcon,
  },
  { id: "brand", labelKey: "nav.brand", href: ROUTES.brand, icon: BriefcaseIcon },
  { id: "guide", labelKey: "nav.guide", href: ROUTES.guide, icon: MapIcon },
  {
    id: "feedback",
    labelKey: "nav.feedback",
    href: ROUTES.feedback,
    icon: MessageSquareIcon,
  },
  {
    id: "discord",
    labelKey: "nav.discord",
    href: DISCORD_INVITE_URL,
    icon: DiscordIcon,
    external: true,
  },
  {
    id: "settings",
    labelKey: "nav.settings",
    href: ROUTES.settings,
    icon: SettingsIcon,
    canShowAttentionDot: true,
  },
];

/**
 * ¿Está activa esta entrada para esta ruta?
 *
 * Prefijo y no igualdad: `/influencers/abc` tiene que dejar `Influencers`
 * marcado. `/` se compara exacto para que `Home` no se active en todas.
 */
export function isNavItemActive(item: NavItem, pathname: string): boolean {
  if (item.external === true) return false;
  if (item.href === "/") return pathname === "/";
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function visibleSecondaryNav(isStaff: boolean): readonly NavItem[] {
  return SECONDARY_NAV.filter((item) => item.staffOnly !== true || isStaff);
}
