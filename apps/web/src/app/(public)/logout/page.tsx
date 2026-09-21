import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Logout · FastGram" };

export default function Page() {
  return <RoutePlaceholder screen="Logout" spec="PRD §3.1 · F-003" task="P1-AUTH-002" />;
}
