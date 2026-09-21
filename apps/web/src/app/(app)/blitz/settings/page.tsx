import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Blitz Settings · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder
      screen="Blitz Settings"
      spec="PRD §3.1 · FR-055"
      task="P2-PREFS-001"
    />
  );
}
