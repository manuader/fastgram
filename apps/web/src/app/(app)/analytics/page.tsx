import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Analytics · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder screen="Analytics" spec="PRD §3.1 · FR-120" task="P3-ANALYT-001" />
  );
}
