import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Upgrade · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder screen="Upgrade" spec="PRD §3.1 · FR-170" task="P4-BILL-001" />
  );
}
