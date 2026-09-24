/**
 * Tier D asistido en `/brand` — `P1-BRAND-014`, PRD `FR-011.4` (fila D),
 * `FR-011.9`.
 *
 * Cuando una fuente social no se pudo leer, `FR-011.4` pide que la UI «lo diga
 * explícitamente y pida la ayuda concreta». La ayuda es pegar la bio y unos
 * captions: `POST /brand/sources/:id/assist` (ver
 * `assistBrandSourceRequestSchema` en contracts), que corre la misma síntesis
 * sobre lo pegado.
 *
 * ## Cuándo se ofrece
 *
 * Una fuente **social** en `failed`: sin extractor en esta instalación,
 * privada, inexistente, o la plataforma limitando. En todos esos casos el
 * worker la deja en `D_assisted`. Una web nunca: se lee sola, y la API la
 * rechaza con 400.
 *
 * ## Por qué no se reintenta
 *
 * Igual que re-analizar (NFR-005): un timeout no dice si el servidor encoló.
 * Reintentar a ciegas puede encolar dos análisis. Ante cualquier fallo se
 * relee el listado y lo que se ve es el estado real.
 */
import {
  BRAND_FREE_TEXT_ANSWER_MAX,
  BRAND_SOURCE_ITEMS_PER_ANALYSIS_DEFAULT,
  brandSourceSchema,
  type AssistBrandSourceRequest,
  type BrandSource,
} from "@fastgram/contracts";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import { apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { queryKeys } from "../api/keys";

export const ASSIST_TEXT_MAX = BRAND_FREE_TEXT_ANSWER_MAX;
export const ASSIST_MAX_CAPTIONS = BRAND_SOURCE_ITEMS_PER_ANALYSIS_DEFAULT;

const SOCIAL: ReadonlySet<BrandSource["sourceType"]> = new Set([
  "instagram",
  "tiktok",
  "x",
  "youtube",
  "linkedin",
]);

/** ¿Se le ofrece a esta fuente pegar la bio? */
export function canAssist(source: BrandSource): boolean {
  return SOCIAL.has(source.sourceType) && source.status === "failed";
}

/**
 * Los captions pegados en un solo campo, separados por **una línea en
 * blanco**. Un caption puede tener saltos de línea propios (los de Instagram y
 * TikTok los tienen), así que un salto simple no separa.
 */
export function splitCaptions(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

export type AssistDraftProblem =
  | { readonly kind: "empty" }
  | { readonly kind: "bioTooLong"; readonly max: number }
  | { readonly kind: "captionTooLong"; readonly max: number; readonly index: number }
  | { readonly kind: "tooManyCaptions"; readonly max: number; readonly count: number };

/**
 * Lo escrito → el cuerpo del `POST`, o el problema que lo impide. Los mismos
 * techos que el contrato: la pantalla lo dice antes de mandar, y la API lo
 * vuelve a validar.
 */
export function assistRequestFrom(
  bio: string,
  captionsText: string,
):
  | { readonly ok: true; readonly body: AssistBrandSourceRequest }
  | { readonly ok: false; readonly problem: AssistDraftProblem } {
  const b = bio.trim();
  const captions = splitCaptions(captionsText);
  if (b === "" && captions.length === 0) return { ok: false, problem: { kind: "empty" } };
  if (b.length > ASSIST_TEXT_MAX) {
    return { ok: false, problem: { kind: "bioTooLong", max: ASSIST_TEXT_MAX } };
  }
  const long = captions.findIndex((c) => c.length > ASSIST_TEXT_MAX);
  if (long !== -1) {
    return {
      ok: false,
      problem: { kind: "captionTooLong", max: ASSIST_TEXT_MAX, index: long + 1 },
    };
  }
  if (captions.length > ASSIST_MAX_CAPTIONS) {
    return {
      ok: false,
      problem: {
        kind: "tooManyCaptions",
        max: ASSIST_MAX_CAPTIONS,
        count: captions.length,
      },
    };
  }
  return {
    ok: true,
    body: {
      ...(b === "" ? {} : { bio: b }),
      ...(captions.length === 0 ? {} : { captions }),
    },
  };
}

export interface AssistVariables {
  readonly id: string;
  readonly body: AssistBrandSourceRequest;
}

/** `POST /brand/sources/:id/assist` → `202` con la fuente en `analyzing`. */
export function useAssistSource(): UseMutationResult<
  BrandSource,
  ApiRequestError,
  AssistVariables
> {
  const queryClient = useQueryClient();
  return useMutation<BrandSource, ApiRequestError, AssistVariables>({
    mutationFn: ({ id, body }) =>
      apiRequest(`/brand/sources/${encodeURIComponent(id)}/assist`, {
        method: "POST",
        body,
        schema: brandSourceSchema,
      }),
    retry: false,
    onSuccess: (updated) => {
      queryClient.setQueryData<BrandSource[]>(queryKeys.brandSources(), (current) =>
        current?.map((s) => (s._id === updated._id ? updated : s)),
      );
    },
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: queryKeys.brandSources() }),
  });
}
