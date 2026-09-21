import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Roadmap · FastGram" };

export default function Page() {
  return <RoutePlaceholder screen="Roadmap" spec="PRD §3.1" />;
}
