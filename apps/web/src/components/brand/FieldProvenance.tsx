"use client";

import type { BrandSource, FieldConfidence, FieldMeta } from "@fastgram/contracts";
import { Badge, type BadgeProps } from "@fastgram/ui";
import { tw } from "@/lib/i18n/t";
import {
  confidenceOf,
  conflictingSources,
  fieldOrigin,
  type FieldOrigin,
} from "@/lib/brand/profile";
import {
  isSocialSourceType,
  SOURCE_TYPE_COPY,
  sourceLabel,
} from "@/lib/brand/source-types";

const CONFIDENCE_TONE: Readonly<
  Record<FieldConfidence, NonNullable<BadgeProps["tone"]>>
> = {
  high: "success",
  medium: "info",
  low: "warning",
};

/**
 * Cómo se nombra una fuente en el badge de origen: `from @mimarca on Instagram`
 * para las sociales, `from miproducto.com` para la web (FR-011.2, PRD:837).
 */
export function originText(source: BrandSource): string {
  const label = sourceLabel(source.sourceType, source.handle);
  const platform = tw(SOURCE_TYPE_COPY[source.sourceType]);
  if (label === "") return tw("brand.origin.platformOnly", { platform });
  if (isSocialSourceType(source.sourceType)) {
    return tw("brand.origin.social", { handle: label, platform });
  }
  return tw("brand.origin.domain", { domain: label });
}

function originCopy(origin: FieldOrigin): string | null {
  switch (origin.kind) {
    case "edited":
      return tw("brand.origin.edited");
    case "source":
      return originText(origin.source);
    case "removedSource":
      return tw("brand.origin.removed");
    case "unknown":
    case "none":
      return null;
  }
}

/**
 * Los badges de un campo del perfil · `F-025`, FR-011.2 (PRD:837-838).
 *
 * Origen, confianza y —si las fuentes se contradijeron (`FR-011.6`)— cuáles.
 *
 * **El badge de origen no es clicable**, aunque el PRD lo pida (*"clicable para
 * ver el extracto exacto"*): el extracto vive en el `BrandSourceSnapshot` y
 * ningún endpoint lo devuelve —`excerptRef` es sólo un puntero—. Un botón que
 * no abre nada es peor que un texto; la pantalla lo dice una vez
 * (`brand.origin.noExcerpt`) en vez de callarlo.
 */
export function FieldProvenance({
  meta,
  sources,
}: {
  readonly meta: FieldMeta | undefined;
  readonly sources: readonly BrandSource[] | undefined;
}) {
  const origin = originCopy(fieldOrigin(meta, sources));
  const confidence = confidenceOf(meta);
  const conflicts = conflictingSources(meta, sources);

  if (origin === null && confidence === null && conflicts.length === 0) return null;

  return (
    <div className="fgw-brand-field__meta">
      {origin !== null && (
        <Badge size="sm" tone="outline" data-origin="true">
          {origin}
        </Badge>
      )}
      {confidence !== null && (
        <Badge size="sm" tone={CONFIDENCE_TONE[confidence]} data-confidence={confidence}>
          {tw("brand.confidence.label", {
            level: tw(`brand.confidence.${confidence}`),
          })}
        </Badge>
      )}
      {conflicts.length > 0 && (
        <p className="fgw-brand-field__conflict">
          {tw("brand.conflict", {
            sources: conflicts
              .map(
                (s) =>
                  sourceLabel(s.sourceType, s.handle) ||
                  tw(SOURCE_TYPE_COPY[s.sourceType]),
              )
              .join(", "),
          })}
        </p>
      )}
    </div>
  );
}
