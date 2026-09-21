import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Library · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder
      screen="Library"
      spec="PRD §3.1 · §3.3 · FR-100"
      task="P2-LIB-001"
    />
  );
}
