import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "SSO callback · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder screen="SSO callback" spec="PRD §3.1 · F-002" task="P1-AUTH-003" />
  );
}
