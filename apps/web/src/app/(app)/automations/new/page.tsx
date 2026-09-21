import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "New automation · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder
      screen="New automation"
      spec="PRD §3.1 · FR-150"
      task="P3-AUTO-001"
    />
  );
}
