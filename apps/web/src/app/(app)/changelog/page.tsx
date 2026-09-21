import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Changelog · FastGram" };

export default function Page() {
  return <RoutePlaceholder screen="Changelog" spec="PRD §3.1" />;
}
