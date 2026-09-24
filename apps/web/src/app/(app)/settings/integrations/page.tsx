import type { Metadata } from "next";
import { IntegrationsSettings } from "@/components/integrations/IntegrationsSettings";
import { PageHeader } from "@/components/shell/PageHeader";
import { INTEGRATIONS_COPY } from "@/lib/integrations/copy";

export const metadata: Metadata = { title: "Integrations · FastGram" };

/**
 * `/settings/integrations` · `PU-PUB-002` (`docs/PLAN-USO-PERSONAL.md` §9).
 * Server component fino, como `/settings/models`.
 */
export default function SettingsIntegrationsPage() {
  return (
    <div className="fgw-page">
      <PageHeader
        title={INTEGRATIONS_COPY.pageTitle}
        description={INTEGRATIONS_COPY.pageDescription}
      />
      <IntegrationsSettings />
    </div>
  );
}
