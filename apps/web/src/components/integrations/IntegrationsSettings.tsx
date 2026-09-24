"use client";

import { Skeleton } from "@fastgram/ui";
import type { IntegrationApp } from "@fastgram/contracts";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { useIntegrations } from "@/lib/integrations/api";
import { INTEGRATIONS_COPY as C } from "@/lib/integrations/copy";
import { IntegrationCard } from "./IntegrationCard";

const META: ReadonlySet<IntegrationApp["platform"]> = new Set([
  "instagram",
  "threads",
  "facebook",
]);

function CardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4">
      <Skeleton shape="text" width="30%" />
      <Skeleton height={36} />
      <Skeleton height={36} />
      <Skeleton shape="text" width="80%" />
    </div>
  );
}

/**
 * Settings → Integrations — `PU-PUB-002`, `docs/PLAN-USO-PERSONAL.md` §9.
 *
 * Las credenciales de las apps de desarrollador (de la instalación, no de una
 * marca). Estados: `loading` (esqueletos), `error` (`ApiErrorState`) y
 * "empty" — que acá no es "no hay nada" (siempre vienen las cinco) sino
 * ninguna configurada, que se ve en cada tarjeta como `Not set up`.
 */
export function IntegrationsSettings() {
  const query = useIntegrations();

  if (query.isError) {
    return (
      <ApiErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  if (query.isPending) {
    return (
      <div className="grid gap-4 lg:grid-cols-2" aria-busy="true">
        <CardSkeleton />
        <CardSkeleton />
      </div>
    );
  }

  const { apps, redirectBase, redirectSource, publicUrlInvalid } = query.data;
  const meta = apps.filter((a) => META.has(a.platform));
  const others = apps.filter((a) => !META.has(a.platform));

  return (
    <div className="flex flex-col gap-8">
      <p className="m-0 text-sm text-text-muted" data-testid="redirect-source">
        {redirectSource === "public_url"
          ? C.redirectFromTunnel(redirectBase)
          : C.redirectLocal}
        {publicUrlInvalid && ` ${C.publicUrlInvalid}`}
      </p>
      <section aria-labelledby="integrations-meta" className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 id="integrations-meta" className="m-0 text-lg font-semibold text-text">
            {C.metaGroupTitle}
          </h2>
          <p className="m-0 text-sm text-text-muted">{C.metaGroupHint}</p>
        </div>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {meta.map((app) => (
            <IntegrationCard key={app.platform} app={app} />
          ))}
        </div>
      </section>
      <section aria-labelledby="integrations-other" className="flex flex-col gap-4">
        <h2 id="integrations-other" className="m-0 text-lg font-semibold text-text">
          {C.otherGroupTitle}
        </h2>
        <div className="grid items-start gap-4 lg:grid-cols-2">
          {others.map((app) => (
            <IntegrationCard key={app.platform} app={app} />
          ))}
        </div>
      </section>
    </div>
  );
}
