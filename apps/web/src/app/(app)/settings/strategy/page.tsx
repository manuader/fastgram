import type { Metadata } from "next";
import { PageHeader } from "@/components/shell/PageHeader";
import { StrategySettings } from "@/components/strategy/StrategySettings";
import { STRATEGY_COPY } from "@/components/strategy/copy";

export const metadata: Metadata = { title: "Strategy · FastGram" };

/**
 * `/settings/strategy` · `PU-BRAND-002` (`docs/PLAN-USO-PERSONAL.md` §2 paso 2).
 *
 * Server component fino, como `/settings/models`: el `<h1>` y nada más. La
 * estrategia es de la marca activa (la del selector del shell).
 */
export default function SettingsStrategyPage() {
  return (
    <div className="fgw-page">
      <PageHeader
        title={STRATEGY_COPY.pageTitle}
        description={STRATEGY_COPY.pageDescription}
      />
      <StrategySettings />
    </div>
  );
}
