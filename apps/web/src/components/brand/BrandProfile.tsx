"use client";

import { Skeleton } from "@fastgram/ui";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { queryKeys } from "@/lib/api/keys";
import { tw } from "@/lib/i18n/t";
import {
  FIELD_LABEL,
  PROFILE_FIELDS,
  PROFILE_SECTIONS,
  useBrandProfile,
  worthAQuickCheck,
  type SectionId,
} from "@/lib/brand/profile";
import { anyInProgress, useBrandSources } from "@/lib/brand/sources";
import { AnglesCard } from "./AnglesCard";
import { BrandSourcesCard } from "./BrandSourcesCard";
import { LogoCard } from "./LogoCard";
import { invalidateOffer } from "./post-analysis-offer";
import { PostAnalysisOfferCard } from "./PostAnalysisOfferCard";
import { ProfilingCard } from "./ProfilingCard";
import { ProposalsCard } from "./ProposalsCard";
import { ProfileSection } from "./ProfileSection";

/**
 * `/brand` · `FR-020` (PRD:996-1025), `F-022`, `F-024`, `F-025`.
 * Tareas `P1-BRANDPG-001` a `-005`.
 *
 * Dos consultas independientes —perfil y fuentes— porque fallan por separado:
 * un error del listado no tiene por qué esconder el perfil, ni al revés.
 *
 * ## `-005`: el re-análisis respeta `editedByUser`… y la pantalla sólo puede decirlo
 *
 * Lo que sí está: `PATCH /brand/profile` marca `editedByUser`, y la fusión de
 * `core` (`reconcileBrandProfile`) **no escribe** esos campos — guarda la
 * propuesta en el snapshot. En pantalla, el campo editado lleva `Edited by you`
 * y la tarjeta de fuentes dice que re-analizar no lo va a pisar.
 *
 * Sprint 7: la propuesta se ve y se decide en {@link ProposalsCard}
 * (`GET /brand/profile/proposals`, `ERR-B14`). Debajo del perfil van el
 * cuestionario (`F-006`), el logo y los content angles; al costado, las fuentes.
 */
export function BrandProfile() {
  const queryClient = useQueryClient();
  const sources = useBrandSources();
  const inProgress = anyInProgress(sources.data);
  const profile = useBrandProfile(inProgress);

  const [editing, setEditing] = useState<SectionId | null>(null);
  const [savedSection, setSavedSection] = useState<SectionId | null>(null);

  // El último refetch del perfil puede salir **antes** de que el análisis
  // escriba. Cuando el listado ve que ya no queda nada en curso, se relee el
  // perfil una vez más; si no, el polling se apaga con el perfil viejo.
  const wasInProgress = useRef(inProgress);
  useEffect(() => {
    if (wasInProgress.current && !inProgress) {
      void queryClient.invalidateQueries({ queryKey: queryKeys.brandProfile() });
      // P1-ONB-007: la oferta aparece recién cuando el análisis terminó.
      invalidateOffer(queryClient);
    }
    wasInProgress.current = inProgress;
  }, [inProgress, queryClient]);

  let profileBody;
  if (profile.isError) {
    profileBody = (
      <ApiErrorState
        error={profile.error}
        onRetry={() => {
          void profile.refetch();
        }}
      />
    );
  } else if (profile.isPending) {
    profileBody = (
      <div className="fgw-brand__loading" aria-busy="true">
        <Skeleton shape="text" width="40%" />
        <Skeleton shape="text" width="80%" />
        <Skeleton shape="text" width="65%" />
      </div>
    );
  } else {
    const data = profile.data;
    const quickCheck = worthAQuickCheck(data);
    profileBody = (
      <>
        <p className="fgw-brand__revision" data-revision={data.brandRevision}>
          {tw("brand.revision", { revision: data.brandRevision })}
        </p>
        {data.status === "pending" && (
          <p className="fgw-brand__notice">{tw("brand.profile.pending")}</p>
        )}
        {data.status === "failed" && (
          <p className="fgw-brand__notice">{tw("brand.profile.failed")}</p>
        )}
        <PostAnalysisOfferCard />
        <ProposalsCard poll={inProgress} />
        {quickCheck.length > 0 && (
          <aside className="fgw-brand__quick-check" aria-labelledby="brand-quick-check">
            <h2 id="brand-quick-check" className="fgw-brand-section__title">
              {tw("brand.quickCheck.title")}
            </h2>
            <p>{tw("brand.quickCheck.body")}</p>
            <ul>
              {quickCheck.map((field) => (
                <li key={field}>{tw(FIELD_LABEL[field])}</li>
              ))}
            </ul>
          </aside>
        )}
        {PROFILE_SECTIONS.map((section) => (
          <ProfileSection
            key={section.id}
            section={section}
            profile={data}
            sources={sources.data}
            editing={editing === section.id}
            canEdit={editing === null}
            justSaved={savedSection === section.id}
            onEdit={() => {
              setSavedSection(null);
              setEditing(section.id);
            }}
            onClose={() => {
              setEditing(null);
            }}
            onSaved={() => {
              setEditing(null);
              setSavedSection(section.id);
            }}
            onReload={() => {
              void profile.refetch();
            }}
          />
        ))}
        <p className="fgw-brand__note">{tw("brand.origin.noExcerpt")}</p>
        <ProfilingCard key={`profiling-${data.brandRevision}`} profile={data} />
        <AnglesCard />
        <LogoCard />
      </>
    );
  }

  const hasEditedFields =
    profile.data !== undefined &&
    PROFILE_FIELDS.some((f) => profile.data.fieldMeta[f]?.editedByUser === true);

  return (
    <div className="fgw-brand">
      <div className="fgw-brand__profile">{profileBody}</div>
      <BrandSourcesCard query={sources} hasEditedFields={hasEditedFields} />
    </div>
  );
}
