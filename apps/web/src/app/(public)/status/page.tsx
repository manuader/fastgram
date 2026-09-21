import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Status · FastGram" };

export default function Page() {
  return <RoutePlaceholder screen="Status" spec="PRD §3.1 · F-255" task="P1-OBS-004" />;
}
