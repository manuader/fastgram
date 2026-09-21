import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Partner checkout · success · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder
      screen="Partner checkout · success"
      spec="PRD §3.1"
      task="P4-BILL-001"
    />
  );
}
