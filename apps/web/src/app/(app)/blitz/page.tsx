import type { Metadata } from "next";
import { BlitzDeck } from "@/components/blitz/deck/BlitzDeck";

export const metadata: Metadata = { title: "Blitz · FastGram" };

/**
 * `/blitz` · FR-050 (PRD:1105), `PU-BLITZ-001` / `PU-BLITZ-002`.
 *
 * Server component fino, como `/blitz/settings`: todo lo que habla con la API
 * vive en `BlitzDeck`, que es cliente (`apps/web` no hace fetch desde el
 * servidor, ver `lib/api/client.ts`).
 */
export default function BlitzPage() {
  return <BlitzDeck />;
}
