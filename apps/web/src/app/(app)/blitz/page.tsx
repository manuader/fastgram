import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Blitz · FastGram" };

export default function Page() {
  return <RoutePlaceholder screen="Blitz" spec="PRD §3.1 · FR-050" task="P2-BLITZ-001" />;
}
