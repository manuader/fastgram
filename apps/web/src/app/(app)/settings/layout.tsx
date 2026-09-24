import type { ReactNode } from "react";
import { SubNav } from "@/components/shell/SubNav";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";

/**
 * Las secciones de `/settings` como rutas de verdad (`PU-UI-001`).
 *
 * `General` es el `/settings` de siempre; `Brands` (`PU-BRAND-001`) y
 * `Models` (la construye otro agente del sprint 1) son subrutas. `SubNav`
 * marca activo por prefijo, así que `General` se compara exacto: si no,
 * quedaría encendido en las tres.
 */
export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="fgw-settings">
      <SubNav
        label={tw("settings.nav.label")}
        links={[
          { href: ROUTES.settings, label: tw("settings.nav.general"), exact: true },
          { href: ROUTES.settingsBrands, label: tw("settings.nav.brands") },
          { href: ROUTES.settingsModels, label: tw("settings.nav.models") },
          // `PU-BRAND-002`. Literal y no `ROUTES`: `lib/nav/routes.ts` es de otro agente.
          { href: "/settings/strategy", label: tw("settings.nav.strategy") },
        ]}
      />
      {children}
    </div>
  );
}
