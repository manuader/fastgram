import type { Metadata } from "next";
import { AutomationWizard } from "@/components/automations/AutomationWizard";
import { PageHeader } from "@/components/shell/PageHeader";
import { tw } from "@/lib/i18n/t";

export const metadata: Metadata = { title: "New automation · FastGram" };

/** `/automations/new` · el wizard de configuración (`F-211`, `F-212`). */
export default function NewAutomationPage() {
  return (
    <div className="fgw-page">
      <PageHeader
        title={tw("automations.new")}
        description={tw("automations.wizard.subtitle")}
      />
      <AutomationWizard />
    </div>
  );
}
