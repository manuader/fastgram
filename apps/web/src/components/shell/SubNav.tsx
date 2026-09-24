"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface SubNavLink {
  readonly href: string;
  readonly label: string;
  /** Activo sólo con la ruta exacta (una sección padre, p. ej. `/settings`). */
  readonly exact?: boolean;
}

/**
 * Navegación secundaria de un módulo (PRD §3.3).
 *
 * Son **enlaces**, no un `Tabs` de `packages/ui`. La diferencia importa: estas
 * "tabs" son rutas de verdad (`/engagement/actions`, `/engagement/insights`,
 * PRD:231-233). Con un widget de tabs con estado interno se pierden la URL
 * compartible, el botón de atrás y la apertura en pestaña nueva. `Tabs` es para
 * cuando el panel **no** cambia la URL.
 */
export function SubNav({
  links,
  label,
}: {
  links: readonly SubNavLink[];
  label: string;
}) {
  const pathname = usePathname();
  return (
    <nav className="fgw-subnav" aria-label={label}>
      <ul className="fgw-subnav__list">
        {links.map((link) => {
          const active =
            pathname === link.href ||
            (link.exact !== true && pathname.startsWith(`${link.href}/`));
          return (
            <li key={link.href}>
              <Link
                href={link.href}
                className="fgw-subnav__link fg-focusable"
                aria-current={active ? "page" : undefined}
                data-active={active ? "true" : undefined}
              >
                {link.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
