import type { Metadata } from "next";
import { InfluencerDetailScreen } from "@/components/influencers/InfluencerDetailScreen";

export const metadata: Metadata = { title: "Influencer · FastGram" };

/**
 * `/influencers/:influencerId` · FR-081 adaptado (`PU-LATER-004`). Las tabs
 * `Videos` y `Configuration` de PRD §3.3 no están: video con personaje no está
 * documentado por la API de Higgsfield, y la configuración (ángulos, cuentas,
 * sets) queda para después.
 */
export default async function InfluencerDetailPage({
  params,
}: {
  readonly params: Promise<{ influencerId: string }>;
}) {
  const { influencerId } = await params;
  return <InfluencerDetailScreen influencerId={influencerId} />;
}
