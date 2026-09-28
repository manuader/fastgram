import type { Metadata } from "next";
import { CampaignWizard } from "@/components/ads/CampaignWizard";
import { PageHeader } from "@/components/shell/PageHeader";
import { tw } from "@/lib/i18n/t";

export const metadata: Metadata = { title: "New ad campaign · FastGram" };

/** `/ads/new` · crear una campaña (siempre pausada; activar pide confirmación). */
export default function NewAdCampaignPage() {
  return (
    <div className="fgw-page">
      <PageHeader title={tw("ads.new")} description={tw("ads.wizard.subtitle")} />
      <CampaignWizard />
    </div>
  );
}
