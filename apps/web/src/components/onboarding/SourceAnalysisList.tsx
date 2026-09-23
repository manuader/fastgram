"use client";

import type { BrandSource } from "@fastgram/contracts";
import { Badge, Spinner, type BadgeProps } from "@fastgram/ui";
import { tw } from "@/lib/i18n/t";
import {
  SOURCE_STATUS_COPY,
  SOURCE_TYPE_COPY,
  sourceLabel,
} from "@/lib/brand/source-types";
import {
  ANALYSIS_SUBSTEPS,
  BRAND_ANALYSIS_POLL_INTERVAL_MS,
  isInProgress,
  sourceNotice,
} from "@/lib/onboarding/processing";
import { useNow } from "@/lib/onboarding/use-now";

const STATUS_TONE: Readonly<
  Record<BrandSource["status"], NonNullable<BadgeProps["tone"]>>
> = {
  pending: "neutral",
  analyzing: "info",
  ready: "success",
  partial: "warning",
  failed: "danger",
  stale: "warning",
};

function SourceRow({
  source,
  now,
}: {
  readonly source: BrandSource;
  readonly now: number;
}) {
  const notice = sourceNotice(source, now);
  const substeps = isInProgress(source.status)
    ? ANALYSIS_SUBSTEPS[source.sourceType]
    : undefined;
  const label = sourceLabel(source.sourceType, source.handle);

  return (
    <li className="fgw-onb-source" data-status={source.status}>
      <div className="fgw-onb-source__head">
        <span className="fgw-onb-source__platform">
          {tw(SOURCE_TYPE_COPY[source.sourceType])}
        </span>
        {label !== "" && <span className="fgw-onb-source__handle">{label}</span>}
        <Badge tone={STATUS_TONE[source.status]} size="sm" dot>
          {tw(SOURCE_STATUS_COPY[source.status])}
        </Badge>
        {isInProgress(source.status) && <Spinner size="sm" aria-hidden="true" />}
      </div>

      {substeps !== undefined && (
        <>
          {/* Sin checks: la API no dice qué sub-paso corre (ver processing.ts). */}
          <ol className="fgw-onb-source__substeps" aria-label={tw("brand.substep.label")}>
            {substeps.map((key) => (
              <li key={key}>{tw(key)}</li>
            ))}
          </ol>
          <p className="fgw-onb-source__note">{tw("brand.substep.noProgress")}</p>
        </>
      )}

      {notice !== null && (
        <p
          className="fgw-onb-source__notice"
          data-problem={notice.problem ? "true" : "false"}
        >
          {tw(notice.key, notice.vars)}
        </p>
      )}
    </li>
  );
}

/**
 * Las fuentes del workspace con el estado de su análisis · `FR-011.2`,
 * `FR-011.8`. La usan el paso 1 (las que ya se añadieron) y el paso 4.
 *
 * `aria-live="polite"` sólo mientras algo está en curso, por el mismo motivo
 * que la grid de la Library: una lista que cambia sola tiene que anunciarse, y
 * una que ya no cambia no tiene por qué repetirse en cada refetch.
 */
export function SourceAnalysisList({
  sources,
}: {
  readonly sources: readonly BrandSource[];
}) {
  const active = sources.some((s) => isInProgress(s.status));
  const now = useNow(active, BRAND_ANALYSIS_POLL_INTERVAL_MS);
  if (sources.length === 0) return null;
  return (
    <ul className="fgw-onb-sources" aria-live={active ? "polite" : "off"}>
      {sources.map((source) => (
        <SourceRow key={source._id} source={source} now={now} />
      ))}
    </ul>
  );
}
