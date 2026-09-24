import type { Metadata } from "next";
import { ConnectionsSettings } from "@/components/connections/ConnectionsSettings";
import { PageHeader } from "@/components/shell/PageHeader";
import { CONNECTIONS_COPY } from "@/lib/connections/copy";

export const metadata: Metadata = { title: "Connections · FastGram" };

interface PageProps {
  /** Next 15: asíncronos. Los pone la ruta de callback del OAuth. */
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const one = (v: string | string[] | undefined): string | undefined =>
  typeof v === "string" && v.length <= 256 ? v : undefined;

/**
 * `/settings/connections` · `PU-PUB-002`, `P3-OAUTH-008`. Las cuentas de la
 * marca activa (la del selector del shell). La query (`connected`, `select`,
 * `error`, `platform`) viene de `app/api/fastgram/oauth/[platform]/callback`.
 */
export default async function SettingsConnectionsPage({ searchParams }: PageProps) {
  const q = await searchParams;
  return (
    <div className="fgw-page">
      <PageHeader
        title={CONNECTIONS_COPY.pageTitle}
        description={CONNECTIONS_COPY.pageDescription(null)}
      />
      <ConnectionsSettings
        notice={{
          connected: one(q["connected"]),
          select: one(q["select"]),
          error: one(q["error"]),
          platform: one(q["platform"]),
        }}
      />
    </div>
  );
}
