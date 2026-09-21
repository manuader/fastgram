import type { Metadata } from "next";
import Link from "next/link";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";

export const metadata: Metadata = { title: "Not found · FastGram" };

/**
 * `/*` → 404 (PRD:293).
 *
 * Sin shell a propósito: si alguien llegó a una ruta que no existe, puede ser
 * que tampoco tenga sesión, y renderizar el sidebar aquí obligaría a resolverla.
 */
export default function NotFound() {
  return (
    <main id="main" className="fgw-centered">
      <h1 className="fgw-centered__title">{tw("error.notFound.title")}</h1>
      <Link href={ROUTES.home} className="fg-btn fg-btn--secondary fg-btn--md">
        {tw("nav.home")}
      </Link>
    </main>
  );
}
