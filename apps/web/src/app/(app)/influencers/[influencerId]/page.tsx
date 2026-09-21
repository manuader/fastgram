import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Influencer · FastGram" };

/**
 * `/influencers/:influencerId` · PRD:236-238.
 *
 * El PRD §3.3 fija las tabs (`Images` · `Videos` · `Configuration`) y que se
 * navegan por query param `?tab=`. No se dibujan aquí porque las tres están
 * vacías: unas tabs que sólo cambian cuál de los tres placeholders se ve
 * enseñan menos que decir que la pantalla no está.
 */
export default function InfluencerDetailPage() {
  return (
    <RoutePlaceholder
      screen="Influencer detail"
      spec="PRD §3.1 · §3.3 · FR-081…FR-083"
      task="P4-INFL-001"
    >
      <p>
        Tabs <code>?tab=images|videos|configuration</code> plus a{" "}
        <code>Configure in Blitz →</code> link, per PRD §3.3.
      </p>
    </RoutePlaceholder>
  );
}
