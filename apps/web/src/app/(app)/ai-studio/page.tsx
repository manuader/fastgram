import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "AI Studio · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder
      screen="AI Studio"
      spec="PRD §3.1 · FR-090"
      task="P4-AISTUDIO-001"
    />
  );
}
