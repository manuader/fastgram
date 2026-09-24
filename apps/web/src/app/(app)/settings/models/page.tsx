import type { Metadata } from "next";
import { ModelsSettings } from "@/components/settings/models/ModelsSettings";
import { PageHeader } from "@/components/shell/PageHeader";
import { MODELS_COPY } from "@/lib/models/copy";

export const metadata: Metadata = { title: "Models · FastGram" };

/**
 * `/settings/models` · `PU-MODEL-002` (`docs/PLAN-USO-PERSONAL.md` §4, D-14).
 *
 * Server component fino, como `/blitz/settings`: el `<h1>` y nada más. Todo lo
 * que habla con la API vive en `ModelsSettings`, que es cliente.
 */
export default function SettingsModelsPage() {
  return (
    <div className="fgw-page">
      <PageHeader
        title={MODELS_COPY.pageTitle}
        description={MODELS_COPY.pageDescription}
      />
      <ModelsSettings />
    </div>
  );
}
