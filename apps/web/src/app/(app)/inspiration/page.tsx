import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Inspiration · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder screen="Inspiration" spec="PRD §3.1 · FR-040" task="P2-TREND-001" />
  );
}
