import type { Metadata } from "next";
import { InfluencersScreen } from "@/components/influencers/InfluencersScreen";

export const metadata: Metadata = { title: "Influencers · FastGram" };

/**
 * `/influencers` · FR-080 adaptado (`PU-LATER-004`). Server component fino:
 * todo lo que habla con la API vive en `InfluencersScreen`, que es cliente.
 */
export default function Page() {
  return <InfluencersScreen />;
}
