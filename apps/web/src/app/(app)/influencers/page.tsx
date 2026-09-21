import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Influencers · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder screen="Influencers" spec="PRD §3.1 · FR-080" task="P4-INFL-001" />
  );
}
