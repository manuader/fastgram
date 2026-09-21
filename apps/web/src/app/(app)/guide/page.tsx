import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Guide · FastGram" };

export default function Page() {
  return <RoutePlaceholder screen="Guide" spec="PRD §3.1" />;
}
