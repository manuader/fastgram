import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Feedback · FastGram" };

export default function Page() {
  return <RoutePlaceholder screen="Feedback" spec="PRD §3.1" />;
}
