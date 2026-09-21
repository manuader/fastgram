import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Onboarding · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder
      screen="Onboarding"
      spec="PRD §3.1 · FR-010 · FR-011"
      task="P1-ONB-001"
    />
  );
}
