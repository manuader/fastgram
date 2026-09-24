"use client";

import type { BrandProfileProposal } from "@fastgram/contracts";
import { Button, Skeleton } from "@fastgram/ui";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { useProfileProposals, useResolveProposal } from "@/lib/brand/intel";
import { FIELD_LABEL, isRevisionConflict, type ProfileField } from "@/lib/brand/profile";
import { tw } from "@/lib/i18n/t";

/**
 * Propuestas del re-análisis — `P1-BRANDPG-005`, `ERR-B14`: *"This source
 * suggests a different answer — replace?"*.
 *
 * La fusión no pisa lo que el usuario editó; acá se ve lo que la fuente
 * propone y se decide campo por campo: **Replace** (acepta, con su
 * procedencia) o **Keep mine** (no vuelve a ofrecerse esa propuesta). Cada
 * decisión lleva la revisión que se vio: si el perfil se movió, 409 y la
 * tarjeta lo dice.
 *
 * Estados: cargando (esqueleto), error (`ApiErrorState`), vacío (la tarjeta no
 * se muestra: no hay nada que decidir).
 */
export function ProposalsCard({ poll }: { readonly poll: boolean }) {
  const query = useProfileProposals(poll);
  const resolve = useResolveProposal();

  if (query.isPending) {
    return (
      <section className="fgw-brand-section" aria-busy="true">
        <Skeleton shape="text" width="40%" />
        <Skeleton shape="text" width="70%" />
      </section>
    );
  }
  if (query.isError) {
    return (
      <section className="fgw-brand-section">
        <ApiErrorState
          error={query.error}
          onRetry={() => {
            void query.refetch();
          }}
        />
      </section>
    );
  }
  const { proposals, brandRevision } = query.data;
  if (proposals.length === 0) return null;

  const decide = (p: BrandProfileProposal, action: "accept" | "dismiss") => {
    resolve.mutate({
      field: p.field,
      action,
      excerptRef: p.excerptRef,
      expectedBrandRevision: brandRevision,
    });
  };

  const conflict = resolve.isError && isRevisionConflict(resolve.error);

  return (
    <section className="fgw-brand-section" aria-labelledby="brand-proposals">
      <header className="fgw-brand-section__header">
        <h2 id="brand-proposals" className="fgw-brand-section__title">
          {tw("brand.proposals.title")}
        </h2>
      </header>
      <p className="fgw-brand__note">{tw("brand.proposals.body")}</p>
      {conflict && (
        <p className="fgw-brand__notice" role="alert">
          {tw("brand.revisionConflict")}
        </p>
      )}
      {resolve.isError && !conflict && (
        <ApiErrorState
          error={resolve.error}
          onRetry={() => {
            resolve.reset();
            void query.refetch();
          }}
        />
      )}
      <ul className="flex flex-col gap-4 p-0" style={{ listStyle: "none" }}>
        {proposals.map((p) => {
          const busy = resolve.isPending && resolve.variables.field === p.field;
          return (
            <li key={p.field} className="fgw-brand-field" data-field={p.field}>
              <p className="fgw-brand-field__label">
                {tw(FIELD_LABEL[p.field as ProfileField])}
              </p>
              <p className="fgw-brand-field__meta">{tw("brand.proposals.suggests")}</p>
              <dl className="grid gap-2 sm:grid-cols-2">
                <div>
                  <dt className="fgw-brand-field__hint">{tw("brand.proposals.yours")}</dt>
                  <dd className="fgw-brand-field__text m-0">
                    {p.currentValue === ""
                      ? tw("brand.proposals.emptyValue")
                      : p.currentValue}
                  </dd>
                </div>
                <div>
                  <dt className="fgw-brand-field__hint">
                    {tw("brand.proposals.fromSource", { platform: p.sourceType })}
                  </dt>
                  <dd className="fgw-brand-field__text m-0">{p.value}</dd>
                </div>
              </dl>
              {p.excerpt !== null && (
                <blockquote className="fgw-brand-field__hint m-0">
                  “{p.excerpt}”
                </blockquote>
              )}
              <div className="fgw-brand-section__actions">
                <Button
                  size="sm"
                  loading={busy && resolve.variables.action === "accept"}
                  disabled={resolve.isPending}
                  onClick={() => {
                    decide(p, "accept");
                  }}
                >
                  {tw("brand.proposals.accept")}
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  loading={busy && resolve.variables.action === "dismiss"}
                  disabled={resolve.isPending}
                  onClick={() => {
                    decide(p, "dismiss");
                  }}
                >
                  {tw("brand.proposals.dismiss")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
