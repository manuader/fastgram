import type { Metadata } from "next";
import { AnalyticsScreen } from "@/components/analytics/AnalyticsScreen";

export const metadata: Metadata = { title: "Analytics · FastGram" };

/**
 * `/analytics` · `FR-120` (PRD:1691), `P3-ANALYT-001/002`, `PU-AUTO-004`.
 *
 * Server component fino: la pantalla es cliente — habla con la API y depende
 * de la marca activa del `WorkspaceProvider`.
 */
export default function AnalyticsPage() {
  return <AnalyticsScreen />;
}
