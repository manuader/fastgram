import type { Metadata } from "next";
import { PageHeader } from "@/components/shell/PageHeader";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";
import { tw } from "@/lib/i18n/t";
import { SETTINGS_SECTIONS } from "@/lib/nav/routes";

export const metadata: Metadata = { title: "Settings · FastGram" };

/**
 * `/settings` · PRD:292 y §3.3.
 *
 * El sitemap da **una** ruta con ocho secciones por id, no ocho rutas. Así que
 * aquí hay una ruta, y las secciones se listan para que se vea el alcance —
 * pero no se inventa un `/settings/account` que el PRD no pone.
 */
export default function SettingsPage() {
  return (
    <div className="fgw-page">
      <PageHeader title={tw("nav.settings")} />
      <RoutePlaceholder
        screen={tw("nav.settings")}
        spec="PRD §3.1 · §3.3 · FR-160"
        task="P1-AUTH-006 · P4-BILL-001 · P3-OAUTH-001"
      >
        <ul className="fgw-inline-list">
          {SETTINGS_SECTIONS.map((section) => (
            <li key={section}>
              <code>{section}</code>
            </li>
          ))}
        </ul>
      </RoutePlaceholder>
    </div>
  );
}
