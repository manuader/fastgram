/**
 * Lo que Blitz lee del design system activo — `PU-S9-003`.
 *
 * Tres usos, una sola lectura por job:
 *
 *  - la **paleta** del kit de fondos (`brand-kit/handler.ts`);
 *  - el **estilo de caption** que se estampa en el `build_plan` de cada
 *    sugerencia nueva ({@link withDesignSystemStyle}, mismo patrón que
 *    `withBrandAudio` del refill): al aceptar, `composeBlitzBuildPayload` lo
 *    usa en vez del preset;
 *  - la **voz** para la copy (`copyStyleFrom`, acotada), que el refill pasa en
 *    `SuggestionCopyInput.designStyle`.
 *
 * Nada de esto hace fallar el refill: sin design system activo, o si la
 * lectura falla, todo sigue como antes (y el error se loguea).
 */
import {
  copyStyleFrom,
  designSystemCaptionStyle,
  designSystemPalette,
  readDesignSystemStyle,
  readDesignSystemTokens,
  type CaptionStyle,
  type CopyDesignStyle,
} from "@fastgram/core";
import { designSystemRepository, type Transaction } from "@fastgram/db";

export interface ActiveDesignSystemForBlitz {
  readonly designSystemId: string;
  readonly palette: readonly string[] | null;
  readonly captionStyle: CaptionStyle | null;
  readonly copyStyle: CopyDesignStyle | null;
}

/** El design system activo de la marca, en la forma que usa Blitz. `null` si no hay. */
export async function readActiveDesignSystem(
  tx: Transaction,
  scope: { readonly companyId: string },
): Promise<ActiveDesignSystemForBlitz | null> {
  const row = await designSystemRepository.findActive(tx, scope);
  if (row === null) return null;
  const tokens = readDesignSystemTokens(row.tokens);
  return {
    designSystemId: row.id,
    palette: tokens === null ? null : designSystemPalette(tokens),
    captionStyle: tokens === null ? null : designSystemCaptionStyle(tokens),
    copyStyle: copyStyleFrom(readDesignSystemStyle(row.style)),
  };
}

/** Lo mínimo de un borrador de sugerencia que hace falta para estamparle el estilo. */
export interface DraftWithBuildPlan {
  readonly buildPlan: unknown;
}

/**
 * Le pone a cada borrador el estilo de caption del design system activo. Un
 * borrador sin `build_plan` objeto se deja igual. Sin design system (o si la
 * lectura falla) devuelve los borradores tal cual.
 */
export async function withDesignSystemStyle<T extends DraftWithBuildPlan>(
  drafts: readonly T[],
  inTx: <R>(fn: (tx: Transaction) => Promise<R>) => Promise<R>,
  scope: { readonly companyId: string },
  onReadError?: (error: unknown) => void,
): Promise<T[]> {
  let style: CaptionStyle | null;
  try {
    style = (await inTx((tx) => readActiveDesignSystem(tx, scope)))?.captionStyle ?? null;
  } catch (error: unknown) {
    onReadError?.(error);
    return [...drafts];
  }
  if (style === null) return [...drafts];
  return drafts.map((draft) =>
    typeof draft.buildPlan === "object" && draft.buildPlan !== null
      ? { ...draft, buildPlan: { ...draft.buildPlan, textStyle: style } }
      : draft,
  );
}
