import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Edit automation · FastGram" };

export default function AutomationEditPage() {
  return (
    <RoutePlaceholder
      screen="Edit automation"
      spec="PRD §3.1 · FR-150"
      task="P3-AUTO-001"
    />
  );
}
