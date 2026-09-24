import type { Metadata } from "next";
import { EngagementScreen } from "@/components/engagement/EngagementScreen";

export const metadata: Metadata = { title: "Engagement · Actions · FastGram" };

interface PageProps {
  /** Next 15: asíncronos. Los pone `engagement/reddit/callback` al volver del OAuth. */
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const one = (v: string | string[] | undefined): string | undefined =>
  typeof v === "string" && v.length <= 64 ? v : undefined;

/**
 * Engagement · Actions — PRD §3.1, §3.3, `FR-140`, `P4-ENGAGE-006…012`. La
 * lista de leads, el detalle con la respuesta y el ban meter.
 */
export default async function Page({ searchParams }: PageProps) {
  const q = await searchParams;
  return (
    <EngagementScreen
      notice={{
        reddit: one(q["reddit"]),
        username: one(q["username"]),
        reason: one(q["reason"]),
      }}
    />
  );
}
