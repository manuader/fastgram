import type { Metadata } from "next";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";

export const metadata: Metadata = { title: "Login · FastGram" };

export default function Page() {
  return (
    <RoutePlaceholder screen="Login" spec="PRD §3.1 · F-001…F-003" task="P1-AUTH-002" />
  );
}
