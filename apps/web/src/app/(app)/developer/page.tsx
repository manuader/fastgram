import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Developers · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder screen="Developers" spec="PRD §3.1 · FR-180" task="P4-PUBAPI-001" />
  );
}
