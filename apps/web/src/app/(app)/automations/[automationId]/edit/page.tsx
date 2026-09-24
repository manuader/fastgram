import type { Metadata } from "next";
import { EditAutomation } from "@/components/automations/EditAutomation";

export const metadata: Metadata = { title: "Edit automation · FastGram" };

interface PageProps {
  readonly params: Promise<{ readonly automationId: string }>;
}

/** `/automations/<id>/edit` · el wizard sobre un borrador (`F-211`: config sólo en DRAFT). */
export default async function AutomationEditPage({ params }: PageProps) {
  const { automationId } = await params;
  return (
    <div className="fgw-page">
      <EditAutomation automationId={automationId} />
    </div>
  );
}
