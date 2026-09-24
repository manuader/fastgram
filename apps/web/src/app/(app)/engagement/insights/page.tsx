import type { Metadata } from "next";
import { EngagementInsights } from "@/components/engagement/EngagementInsights";

export const metadata: Metadata = { title: "Engagement · Insights · FastGram" };

/**
 * Engagement · Insights — PRD §3.1, §3.3, `FR-140`. El ban meter con sus
 * conteos (`F-197`, `F-200`): cómo se leen las respuestas enviadas.
 */
export default function Page() {
  return <EngagementInsights />;
}
