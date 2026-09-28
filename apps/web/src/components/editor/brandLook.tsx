"use client";

/**
 * La marca en el editor clásico · sprint 9 (S), `PU-S9-003`.
 *
 * El editor tiene que ofrecer las familias **de la marca** (`brand:<id>`)
 * además de las 12 de `FR-051`, pintarlas con sus propios archivos en el
 * preview, y mostrar la capa de logo. Todo sale del design system activo
 * (`GET /design-system`, el mismo query que la pantalla de marca, así que la
 * caché se comparte): familias con su licencia, caras con `fileRef` y los
 * logos.
 *
 * Las caras se cargan con `FontFace` desde `GET /design-system/…/font-files`
 * (`data:` URL: ver el contrato de M) con `useBrandFontFace`, que les da el
 * nombre CSS `fg-ds-<id>-<familia>`; ese mismo nombre lo pide el lienzo.
 *
 * Las 12 siguen saliendo de `lib/editor/fonts.ts`; acá sólo se suma la marca
 * por delante, para no tocar ese módulo (lo usa también el editor de reels).
 */
import {
  brandFontIdOf,
  isBrandFontFamily,
  type BuildLogo,
  type DesignSystemResource,
} from "@fastgram/contracts";
import { createContext, useContext, type CSSProperties } from "react";

import { useBrandFontFace, useDesignSystem } from "@/components/design-system/api";
import {
  FALLBACK_FAMILY,
  closestWeight,
  cssFontFamily,
  fontSpec,
  type EditorFontSpec,
} from "@/lib/editor/fonts";

type Family = DesignSystemResource["families"][number];

export interface EditorBrandFamily {
  /** `brand:<id>`: lo que va en la caja. */
  readonly family: `brand:${string}`;
  readonly id: string;
  readonly name: string;
  /** Se dibuja con sus archivos: licencia tildada (o libre) y archivos subidos. */
  readonly usable: boolean;
  readonly license: Family["license"];
  readonly fallbackName: string;
  /** Pesos con cara normal subida (los que existen de verdad en el render). */
  readonly weights: readonly number[];
  readonly faces: readonly {
    readonly weight: number;
    readonly style: "normal" | "italic";
    readonly fileRef: string;
  }[];
}

export interface EditorBrandLook {
  readonly designSystemId: string | null;
  readonly families: readonly EditorBrandFamily[];
  /** URLs de las variantes del logo (media de la marca). */
  readonly logos: readonly string[];
}

export const EMPTY_BRAND_LOOK: EditorBrandLook = {
  designSystemId: null,
  families: [],
  logos: [],
};

/** Lo que usan el inspector y el lienzo sin pasarlo prop por prop. */
export const BrandLookContext = createContext<EditorBrandLook>(EMPTY_BRAND_LOOK);

export function useBrandLook(): EditorBrandLook {
  return useContext(BrandLookContext);
}

/** Del recurso del design system a lo que usa el editor. Sólo familias con archivos. */
export function brandLookOf(
  ds: DesignSystemResource | null | undefined,
): EditorBrandLook {
  if (ds === null || ds === undefined || ds.status !== "ready") return EMPTY_BRAND_LOOK;
  const families: EditorBrandFamily[] = ds.families
    .filter((f) => f.origin === "file")
    .map((f) => {
      const faces = f.faces
        .filter((face) => face.fileRef !== null)
        .map((face) => ({
          weight: face.weight,
          style: face.style,
          fileRef: face.fileRef as string,
        }));
      const normal = faces.filter((face) => face.style === "normal");
      const weights = [
        ...new Set((normal.length > 0 ? normal : faces).map((x) => x.weight)),
      ];
      return {
        family: `brand:${f.id}` as const,
        id: f.id,
        name: f.name,
        usable: f.usable && faces.length > 0,
        license: f.license,
        fallbackName: f.fallbackName,
        weights: weights.sort((a, b) => a - b),
        faces,
      };
    });
  return {
    designSystemId: ds.id,
    families,
    logos: ds.assets.filter((a) => a.kind === "logo").map((a) => a.url),
  };
}

/** El design system activo, en la forma del editor. */
export function useEditorBrandLook(): EditorBrandLook {
  const state = useDesignSystem();
  return brandLookOf(state.data?.active);
}

/** Mismo nombre que le pone `useBrandFontFace`. */
export function brandCssFamily(designSystemId: string, familyId: string): string {
  return `fg-ds-${designSystemId.slice(0, 8)}-${familyId}`;
}

export function brandFamilyOf(
  family: string,
  look: EditorBrandLook,
): EditorBrandFamily | null {
  if (!isBrandFontFamily(family)) return null;
  const id = brandFontIdOf(family);
  return look.families.find((f) => f.id === id) ?? null;
}

/** `font-family` CSS de una caja: la de la marca con la reserva detrás, o una de las 12. */
export function editorCssFamily(family: string, look: EditorBrandLook): string {
  const brand = brandFamilyOf(family, look);
  if (brand !== null && look.designSystemId !== null && brand.usable) {
    return `"${brandCssFamily(look.designSystemId, brand.id)}", "${FALLBACK_FAMILY}", sans-serif`;
  }
  if (isBrandFontFamily(family)) return `"${FALLBACK_FAMILY}", sans-serif`;
  return cssFontFamily(family as EditorFontSpec["key"]);
}

/** Los pesos del selector: las caras de la marca, o la tabla de `FR-051`. */
export function editorWeights(family: string, look: EditorBrandLook): readonly number[] {
  if (isBrandFontFamily(family)) {
    const brand = brandFamilyOf(family, look);
    return brand === null || brand.weights.length === 0 ? [400] : brand.weights;
  }
  return fontSpec(family as EditorFontSpec["key"]).weights;
}

/** El peso más cercano que existe en la familia (al cambiar de familia). */
export function editorClosestWeight(
  family: string,
  weight: number,
  look: EditorBrandLook,
): number {
  if (!isBrandFontFamily(family)) {
    return closestWeight(family as EditorFontSpec["key"], weight);
  }
  const weights = editorWeights(family, look);
  let best = weights[0] ?? 400;
  for (const w of weights) if (Math.abs(w - weight) < Math.abs(best - weight)) best = w;
  return best;
}

/**
 * Carga en el documento las caras de las familias de marca usables. No pinta
 * nada: el lienzo y el selector piden la familia por nombre CSS.
 */
export function BrandFontFaces({ look }: { readonly look: EditorBrandLook }) {
  const id = look.designSystemId;
  if (id === null) return null;
  return (
    <>
      {look.families
        .filter((f) => f.usable)
        .flatMap((f) =>
          f.faces.map((face) => (
            <BrandFace
              key={`${f.id}-${face.fileRef}`}
              designSystemId={id}
              familyId={f.id}
              fileRef={face.fileRef}
              weight={face.weight}
              fontStyle={face.style}
            />
          )),
        )}
    </>
  );
}

function BrandFace({
  designSystemId,
  familyId,
  fileRef,
  weight,
  fontStyle,
}: {
  readonly designSystemId: string;
  readonly familyId: string;
  readonly fileRef: string;
  readonly weight: number;
  readonly fontStyle: "normal" | "italic";
}) {
  useBrandFontFace(designSystemId, fileRef, familyId, weight, fontStyle);
  return null;
}

/* ------------------------------------------------------------------------ *
 * El logo en el lienzo
 * ------------------------------------------------------------------------ */

/** Los mismos números que el render (`services/render/src/render/logoLayer.ts`). */
export const LOGO_WIDTH_RATIO: Readonly<Record<BuildLogo["size"], number>> = {
  small: 0.12,
  medium: 0.18,
  large: 0.24,
};
export const LOGO_MAX_HEIGHT_RATIO = 0.12;
export const LOGO_MARGIN_RATIO = 0.05;

/**
 * Dónde va el logo en el preview, en px de pantalla. El ancho y el margen son
 * los del render; la altura la da la proporción de la imagen (con el tope del
 * 12 % del alto vía `max-height` + `object-fit: contain`).
 */
export function logoPreviewStyle(
  logo: BuildLogo,
  previewWidth: number,
  previewHeight: number,
): CSSProperties {
  const margin = previewWidth * LOGO_MARGIN_RATIO;
  const vertical = logo.corner.startsWith("top") ? "top" : "bottom";
  const horizontal = logo.corner.endsWith("left") ? "left" : "right";
  return {
    position: "absolute",
    [vertical]: margin,
    [horizontal]: margin,
    width: previewWidth * LOGO_WIDTH_RATIO[logo.size],
    maxHeight: previewHeight * LOGO_MAX_HEIGHT_RATIO,
    objectFit: "contain",
    objectPosition: `${horizontal} ${vertical}`,
    opacity: logo.opacity,
    pointerEvents: "none",
    userSelect: "none",
  };
}
