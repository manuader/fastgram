import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Refer & Earn · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder
      screen="Refer & Earn"
      spec="PRD §3.1 · F-250"
      task="P5-GROWTH-001"
    />
  );
}
