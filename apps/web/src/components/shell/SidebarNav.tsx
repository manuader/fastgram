"use client";

import { Tooltip } from "@fastgram/ui";
import Link from "next/link";
import { ExternalLinkIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";
import { isNavItemActive, type NavItem } from "@/lib/nav/navigation";

interface SidebarNavProps {
  items: readonly NavItem[];
  pathname: string;
  /** Modo icono: el label se oculta visualmente, **no** se quita del DOM. */
  collapsed: boolean;
  /** Etiqueta del grupo para lectores de pantalla (`Main` / `More`). */
  label: string;
  /** Ids con punto de atención pendiente (PRD:338, hoy `Settings`). */
  attention?: ReadonlySet<string>;
  onNavigate?: () => void;
}

/**
 * Una lista de entradas del sidebar.
 *
 * Tres decisiones que no son cosméticas:
 *
 * 1. **El label nunca sale del DOM.** Colapsado se le añade
 *    `fg-visually-hidden`. Si se quitara, el enlace se quedaría sin nombre
 *    accesible y un lector de pantalla leería diez veces "enlace".
 * 2. **El tooltip sólo existe colapsado** (`FR-001`, PRD:336). Expandido el
 *    label ya está a la vista y repetirlo al pasar el mouse es ruido.
 *    `Tooltip` de `packages/ui` aparece también **con el foco del teclado**,
 *    así que el modo icono no deja fuera a quien no usa mouse.
 * 3. **`aria-current="page"`**, no sólo una clase. El resalte de color es para
 *    quien ve; `aria-current` es para todos los demás.
 */
export function SidebarNav({
  items,
  pathname,
  collapsed,
  label,
  attention,
  onNavigate,
}: SidebarNavProps) {
  return (
    <nav aria-label={label} className="fgw-nav">
      <ul className="fgw-nav__list">
        {items.map((item) => {
          const Icon = item.icon;
          const text = tw(item.labelKey);
          const active = isNavItemActive(item, pathname);
          const showDot =
            item.canShowAttentionDot === true && attention?.has(item.id) === true;

          const link = (
            <Link
              href={item.href}
              className="fgw-nav__link fg-focusable"
              aria-current={active ? "page" : undefined}
              data-active={active ? "true" : undefined}
              {...(item.external === true
                ? { target: "_blank", rel: "noreferrer noopener" }
                : {})}
              {...(onNavigate === undefined ? {} : { onClick: onNavigate })}
            >
              <span className="fgw-nav__icon">
                <Icon />
              </span>
              <span className={collapsed ? "fg-visually-hidden" : "fgw-nav__label"}>
                {text}
              </span>
              {item.external === true && !collapsed && (
                <span className="fgw-nav__trailing">
                  <ExternalLinkIcon size={14} />
                  <span className="fg-visually-hidden">{tw("nav.opensInNewTab")}</span>
                </span>
              )}
              {showDot && (
                <span className="fgw-nav__dot" role="status">
                  <span className="fg-visually-hidden">{tw("nav.actionRequired")}</span>
                </span>
              )}
            </Link>
          );

          return (
            <li key={item.id} className="fgw-nav__item">
              {collapsed ? (
                <Tooltip content={text} side="right">
                  {link}
                </Tooltip>
              ) : (
                link
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
