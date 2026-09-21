import type { ReactNode } from "react";
import { PageHeader } from "@/components/shell/PageHeader";
import { SubNav } from "@/components/shell/SubNav";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";

/**
 * Engagement · PRD §3.3: "sub-rutas `actions` e `insights`", CONFIRMED `[APP]`.
 *
 * Los labels de las dos sub-rutas los da el PRD en §3.1 (PRD:231-233) como
 * `Actions / lista de leads` e `Insights de engagement`. Se usa la palabra
 * literal de cada una, no una traducción libre.
 */
export default function EngagementLayout({ children }: { children: ReactNode }) {
  return (
    <div className="fgw-page">
      <PageHeader title={tw("nav.engagement")} />
      <SubNav
        label={tw("nav.engagement")}
        links={[
          { href: ROUTES.engagementActions, label: "Actions" },
          { href: ROUTES.engagementInsights, label: "Insights" },
        ]}
      />
      {children}
    </div>
  );
}
