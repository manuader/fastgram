import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Calendar · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder screen="Calendar" spec="PRD §3.1 · FR-110" task="P2-CAL-001" />
  );
}
