import type { Metadata } from "next";
import { AutomationDetail } from "@/components/automations/AutomationDetail";

export const metadata: Metadata = { title: "Automation · FastGram" };

interface PageProps {
  readonly params: Promise<{ readonly automationId: string }>;
}

/**
 * `/automations/<id>` · el detalle y la revisión de una campaña (`FR-150`,
 * `F-213…F-220`). Sin validar el id acá: inexistente y ajena son el mismo 404
 * de la API (§9.2), y lo cuenta la pantalla.
 */
export default async function AutomationDetailPage({ params }: PageProps) {
  const { automationId } = await params;
  return (
    <div className="fgw-page">
      <AutomationDetail automationId={automationId} />
    </div>
  );
}
