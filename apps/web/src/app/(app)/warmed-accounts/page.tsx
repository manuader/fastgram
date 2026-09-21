import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Warmed Accounts · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder
      screen="Warmed Accounts"
      spec="PRD §3.1 · FR-130"
      task="P3-WARM-001"
    />
  );
}
