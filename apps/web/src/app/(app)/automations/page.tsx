import type { Metadata } from "next";
import {
  AutomationsList,
  NewAutomationButton,
} from "@/components/automations/AutomationsList";
import { PageHeader } from "@/components/shell/PageHeader";
import { tw } from "@/lib/i18n/t";

export const metadata: Metadata = { title: "Automations · FastGram" };

/**
 * `/automations` · `FR-150`: las campañas multi-semana de la marca activa,
 * con estado y progreso, y `New automation`. Server component fino; lo que
 * habla con la API vive en `AutomationsList`.
 */
export default function AutomationsPage() {
  return (
    <div className="fgw-page">
      <PageHeader
        title={tw("automations.title")}
        description={tw("automations.subtitle")}
        actions={<NewAutomationButton />}
      />
      <AutomationsList />
    </div>
  );
}
