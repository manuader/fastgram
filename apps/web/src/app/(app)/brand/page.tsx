import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Brand · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder screen="Brand" spec="PRD §3.1 · FR-020" task="P1-BRANDPG-001" />
  );
}
