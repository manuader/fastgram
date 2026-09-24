"use client";

/**
 * La oferta post-análisis de `/brand` · `P1-ONB-007`, `D-04`, `FR-011.5.1`.
 *
 * `GET /brand/post-analysis-offer` dice si mostrarla: la API exige una fuente
 * que **terminó** (`ready`/`partial`), así que la tarjeta nunca aparece antes
 * del análisis. Descartarla es por marca y en el servidor.
 */
import { postAnalysisOfferSchema, type PostAnalysisOffer } from "@fastgram/contracts";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiSend } from "@/lib/api/client";
import type { ApiRequestError } from "@/lib/api/errors";
import { useApiQuery } from "@/lib/api/hooks";
import { tw } from "@/lib/i18n/t";

export const POST_ANALYSIS_OFFER_PATH = "/brand/post-analysis-offer";
export const postAnalysisOfferKey = ["brand", "post-analysis-offer"] as const;

/**
 * Se vuelve a leer cuando termina un análisis: `BrandProfile` invalida la
 * clave al ver que ya no queda nada en curso (ver {@link invalidateOffer}).
 */
export function usePostAnalysisOffer(): UseQueryResult<
  PostAnalysisOffer,
  ApiRequestError
> {
  return useApiQuery<PostAnalysisOffer>({
    queryKey: [...postAnalysisOfferKey],
    path: POST_ANALYSIS_OFFER_PATH,
    schema: postAnalysisOfferSchema,
  });
}

export function invalidateOffer(queryClient: ReturnType<typeof useQueryClient>): void {
  void queryClient.invalidateQueries({ queryKey: [...postAnalysisOfferKey] });
}

export function useDismissPostAnalysisOffer(): UseMutationResult<
  void,
  ApiRequestError,
  void
> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiRequestError, void>({
    mutationFn: () => apiSend(`${POST_ANALYSIS_OFFER_PATH}/dismiss`, { method: "POST" }),
    onSuccess: () => {
      queryClient.setQueryData<PostAnalysisOffer>([...postAnalysisOfferKey], (current) =>
        current === undefined ? current : { ...current, show: false, dismissed: true },
      );
    },
  });
}

type OfferSource = NonNullable<PostAnalysisOffer["source"]>;

/** Las redes con handle (`@marca`); una web no tiene handle que conectar. */
const SOCIAL: ReadonlySet<string> = new Set([
  "instagram",
  "tiktok",
  "x",
  "youtube",
  "linkedin",
]);

/** El cuerpo de la tarjeta: el copy del PRD con `@handle` si la fuente es una red. */
export function offerBody(source: OfferSource | null): string {
  if (source !== null && SOCIAL.has(source.sourceType) && (source.handle ?? "") !== "") {
    return tw("brand.offer.bodyHandle", {
      handle: (source.handle ?? "").replace(/^@/, ""),
    });
  }
  return tw("brand.offer.bodyGeneric");
}
