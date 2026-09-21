import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Automation · FastGram" };

export default function AutomationDetailPage() {
  return (
    <RoutePlaceholder
      screen="Automation detail"
      spec="PRD §3.1 · FR-150"
      task="P3-AUTO-001"
    />
  );
}
