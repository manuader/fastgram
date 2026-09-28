import type { Metadata } from "next";
import { CampaignDetail } from "@/components/ads/CampaignDetail";

export const metadata: Metadata = { title: "Ad campaign · FastGram" };

interface PageProps {
  readonly params: Promise<{ readonly campaignId: string }>;
}

/**
 * `/ads/<id>` · detalle de una campaña paga. Sin validar el id acá:
 * inexistente y ajena son el mismo 404 de la API (§9.2).
 */
export default async function AdCampaignPage({ params }: PageProps) {
  const { campaignId } = await params;
  return (
    <div className="fgw-page">
      <CampaignDetail campaignId={campaignId} />
    </div>
  );
}
