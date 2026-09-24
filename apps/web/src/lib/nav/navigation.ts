/**
 * Modelo del sidebar · `P1-UI-003` / `FR-001`, reordenado por `PU-UI-001`.
 *
 * **El orden cambió respecto del PRD §3.2** (PRD:293-338, "orden exacto").
 * Con el giro a uso personal (PRD §2.7 D-06…D-17, PLAN-USO-PERSONAL §7) la
 * navegación sigue el circuito diario —Home, Blitz, Calendar, Library, Brand,
 * Studio— y después lo que se usa menos. Es una decisión del coordinador del
 * sprint 1 que el §3.2 del PRD todavía no refleja: hay que corregirlo allí.
 *
 * Lo que D-15 saca del producto en modo personal (Warmed Accounts, Refer &
 * Earn; Upgrade/Developers/Roadmap/Changelog nunca estuvieron en el sidebar)
 * se marca con `hideInPersonal` y **no** se borra: las rutas siguen vivas y en
 * modo `standard` las entradas vuelven.
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
  ZapIcon,
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
  /** PRD §2.7 D-15 — fuera del producto en modo personal. */
  readonly hideInPersonal?: boolean;
}

/** El circuito de uso personal (PLAN §2): lo que se toca todos los días. */
export const PRIMARY_NAV: readonly NavItem[] = [
  { id: "home", labelKey: "nav.home", href: ROUTES.home, icon: HomeIcon },
  { id: "blitz", labelKey: "nav.blitz", href: ROUTES.blitz, icon: RocketIcon },
  {
    id: "calendar",
    labelKey: "nav.calendar",
    href: ROUTES.calendar,
    icon: CalendarIcon,
  },
  { id: "library", labelKey: "nav.library", href: ROUTES.library, icon: LibraryIcon },
  { id: "brand", labelKey: "nav.brand", href: ROUTES.brand, icon: BriefcaseIcon },
  // `Studio` es el catálogo de formatos + video propio (`/content`).
  {
    id: "content",
    labelKey: "nav.studio",
    href: ROUTES.content,
    icon: ClapperboardIcon,
  },
];

/** Crear y medir: se usa, pero no cada día. */
export const TOOLS_NAV: readonly NavItem[] = [
  { id: "ai-studio", labelKey: "nav.aiStudio", href: ROUTES.aiStudio, icon: WandIcon },
  {
    id: "influencers",
    labelKey: "nav.influencers",
    href: ROUTES.influencers,
    icon: UserIcon,
  },
  {
    id: "analytics",
    labelKey: "nav.analytics",
    href: ROUTES.analytics,
    icon: BarChartIcon,
  },
  {
    id: "automations",
    labelKey: "nav.automations",
    href: ROUTES.automations,
    icon: ZapIcon,
  },
  // D-15: Engagement (Reddit) queda "al final" del orden de trabajo, no fuera.
  {
    id: "engagement",
    labelKey: "nav.engagement",
    href: ROUTES.engagement,
    icon: UsersIcon,
  },
  {
    id: "warmed-accounts",
    labelKey: "nav.warmedAccounts",
    href: ROUTES.warmedAccounts,
    icon: UsersRoundIcon,
    hideInPersonal: true,
  },
];

/**
 * El bloque de abajo, con `Settings` al final.
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
    hideInPersonal: true,
  },
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

export interface NavVisibility {
  isStaff: boolean;
  /**
   * El modo de la app (`GET /mode`), o `null` mientras no se sabe. Sin saberlo
   * se esconde lo de D-15: el producto hoy es de uso personal, y es mejor que
   * una entrada aparezca tarde en `standard` a que desaparezca en `personal`.
   */
  mode: "personal" | "standard" | null;
}

export function isNavItemVisible(
  item: NavItem,
  { isStaff, mode }: NavVisibility,
): boolean {
  if (item.staffOnly === true && !isStaff) return false;
  if (item.hideInPersonal === true && mode !== "standard") return false;
  return true;
}

export function visibleNav(
  items: readonly NavItem[],
  visibility: NavVisibility,
): readonly NavItem[] {
  return items.filter((item) => isNavItemVisible(item, visibility));
}

/** Compatibilidad: el bloque de abajo en modo `standard`. */
export function visibleSecondaryNav(isStaff: boolean): readonly NavItem[] {
  return visibleNav(SECONDARY_NAV, { isStaff, mode: "standard" });
}
