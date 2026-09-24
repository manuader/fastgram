"use client";

import { ErrorState, Skeleton } from "@fastgram/ui";
import Link from "next/link";
import { PageHeader } from "@/components/shell/PageHeader";
import { tw } from "@/lib/i18n/t";
import { useAutomation } from "@/lib/automations/api";
import { AutomationWizard } from "./AutomationWizard";
import { automationHref } from "./AutomationsList";

/**
 * El wizard sobre un borrador. Fuera de `DRAFT` la configuración está
 * bloqueada (`FR-150`): se dice y se ofrece volver al detalle.
 */
export function EditAutomation({ automationId }: { readonly automationId: string }) {
  const query = useAutomation(automationId);
  if (query.isPending) {
    return (
      <Skeleton className="h-96 w-full rounded-xl" aria-label={tw("common.loading")} />
    );
  }
  if (query.isError) {
    return (
      <ErrorState
        title={
          query.error.code === "not_found"
            ? tw("automations.detail.notFound")
            : tw("automations.detail.error")
        }
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }
  const a = query.data;
  return (
    <>
      <PageHeader title={tw("automations.edit.title", { name: a.name })} />
      {a.status === "DRAFT" ? (
        <AutomationWizard automation={a} />
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-text-muted">{tw("automations.blocked.locked")}</p>
          <Link
            href={automationHref(a.id)}
            className="fg-btn fg-btn--secondary fg-btn--md w-fit"
          >
            {tw("automations.edit.back")}
          </Link>
        </div>
      )}
    </>
  );
}
