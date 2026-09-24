/**
 * Inteligencia de marca en `/brand` (sprint 7, agente D):
 *
 *  - propuestas del re-análisis, aceptar / conservar (`P1-BRANDPG-005`, `ERR-B14`);
 *  - cuestionario de perfilado (`P1-ONB-004`, `F-006`) sobre `POST /onboarding/profiling`;
 *  - logo (`P1-ONB-003`), reducido en el navegador y subido como `data:` URL;
 *  - capturas → texto para el tier D (`P1-BRAND-014`), de a una por pedido;
 *  - content angles: listar, generar, editar, pesar, borrar (`P2-ANGLE-005`).
 *
 * Las claves de caché cuelgan de `["brand", …]` y de `["blitz", …]`: al cambiar
 * de marca se resetean con el resto (ver `isBrandIndependentKey`).
 */
import {
  BRAND_LOGO_MAX_BYTES,
  BRAND_OCR_IMAGE_MAX_BYTES,
  blitzPreferencesSchema,
  brandLogoSchema,
  brandOcrResultSchema,
  brandProfileProposalsSchema,
  companyProfileSchema,
  contentAngleSchema,
  generatedContentAngleSchema,
  type BlitzPreferences,
  type BrandLogo,
  type BrandOcrResult,
  type BrandProfileProposals,
  type CompanyProfile,
  type ContentAngle,
  type CreateContentAngleRequest,
  type GeneratedContentAngle,
  type ResolveBrandProfileProposalRequest,
  type SubmitOnboardingProfilingRequest,
  type UpdateContentAngleRequest,
} from "@fastgram/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { apiList, apiRequest, apiSend, type CursorPage } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { queryKeys } from "../api/keys";
import { brandKeys } from "../brands/workspaces";

export const intelKeys = {
  proposals: () => ["brand", "proposals"] as const,
  angles: () => ["blitz", "angles", "all"] as const,
  logo: () => ["brand", "logo"] as const,
};

/* ------------------------------------------------------------------------ *
 * Propuestas
 * ------------------------------------------------------------------------ */

export function useProfileProposals(
  poll: boolean,
): UseQueryResult<BrandProfileProposals, ApiRequestError> {
  return useQuery<BrandProfileProposals, ApiRequestError>({
    queryKey: intelKeys.proposals(),
    queryFn: ({ signal }) =>
      apiRequest("/brand/profile/proposals", {
        signal,
        schema: brandProfileProposalsSchema,
      }),
    refetchInterval: poll ? 5_000 : false,
  });
}

export interface ResolveProposalVariables extends ResolveBrandProfileProposalRequest {
  readonly field: string;
}

export function useResolveProposal(): UseMutationResult<
  CompanyProfile,
  ApiRequestError,
  ResolveProposalVariables
> {
  const queryClient = useQueryClient();
  return useMutation<CompanyProfile, ApiRequestError, ResolveProposalVariables>({
    mutationFn: ({ field, ...body }) =>
      apiRequest(`/brand/profile/proposals/${encodeURIComponent(field)}`, {
        method: "POST",
        body,
        schema: companyProfileSchema,
      }),
    retry: false,
    onSuccess: (profile) => {
      queryClient.setQueryData<CompanyProfile>(queryKeys.brandProfile(), profile);
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: intelKeys.proposals() }),
  });
}

/* ------------------------------------------------------------------------ *
 * Cuestionario de perfilado — F-006
 * ------------------------------------------------------------------------ */

/**
 * Opciones de las preguntas cerradas. **El PRD no las da** (`FR-010` sólo
 * nombra las preguntas y `Select one`): son una decisión de esta tarea, y cada
 * pregunta acepta además «Other» con texto libre.
 */
export const PROFILING_OPTIONS = {
  ownerRole: [
    "Founder / Owner",
    "Marketing",
    "Social media manager",
    "Agency",
    "Creator",
  ],
  teamSize: ["Just me", "2–10", "11–50", "51–200", "200+"],
  businessModel: ["B2C", "B2B", "Marketplace", "Creator / personal brand", "Non-profit"],
  businessCategories: [
    "E-commerce",
    "SaaS / Apps",
    "Food & drink",
    "Health & fitness",
    "Beauty & fashion",
    "Education",
    "Services",
    "Media & entertainment",
  ],
  monthlyRevenueBand: ["Pre-revenue", "< $10k", "$10k–$50k", "$50k–$250k", "$250k+"],
  expectations: [
    "Grow followers",
    "Get more sales",
    "Save time posting",
    "Test content ideas",
    "Build brand awareness",
  ],
} as const;

export type ProfilingKey = keyof typeof PROFILING_OPTIONS;

export const PROFILING_KEYS: readonly ProfilingKey[] = [
  "ownerRole",
  "teamSize",
  "businessModel",
  "businessCategories",
  "monthlyRevenueBand",
  "expectations",
];

export const MULTI_PROFILING_KEYS: ReadonlySet<ProfilingKey> = new Set([
  "businessCategories",
  "expectations",
]);

/**
 * El borrador: por pregunta, las opciones elegidas de la lista y el texto de
 * «Other». En las de una respuesta, `OTHER_CHOICE` en `chosen` significa que
 * la respuesta es el texto.
 */
export const OTHER_CHOICE = "__other__";

export interface ProfilingDraft {
  readonly chosen: Readonly<Record<ProfilingKey, readonly string[]>>;
  readonly other: Readonly<Record<ProfilingKey, string>>;
}

function isOption(key: ProfilingKey, value: string): boolean {
  return (PROFILING_OPTIONS[key] as readonly string[]).includes(value);
}

export function profilingDraftFrom(profile: CompanyProfile | undefined): ProfilingDraft {
  const raw: Record<ProfilingKey, readonly string[]> = {
    ownerRole: profile?.ownerRole === undefined ? [] : [profile.ownerRole],
    teamSize: profile?.teamSize === undefined ? [] : [profile.teamSize],
    businessModel: profile?.businessModel === undefined ? [] : [profile.businessModel],
    businessCategories: profile?.businessCategories ?? [],
    monthlyRevenueBand:
      profile?.monthlyRevenueBand === undefined ? [] : [profile.monthlyRevenueBand],
    expectations: profile?.expectations ?? [],
  };
  const chosen = {} as Record<ProfilingKey, readonly string[]>;
  const other = {} as Record<ProfilingKey, string>;
  for (const key of PROFILING_KEYS) {
    const values = raw[key].map((v) => v.trim()).filter((v) => v !== "");
    const known = values.filter((v) => isOption(key, v));
    const unknown = values.filter((v) => !isOption(key, v));
    other[key] = unknown.join(", ");
    chosen[key] =
      MULTI_PROFILING_KEYS.has(key) || unknown.length === 0 ? known : [OTHER_CHOICE];
  }
  return { chosen, other };
}

/** Las respuestas de una pregunta, ya combinadas con «Other». */
export function profilingAnswers(draft: ProfilingDraft, key: ProfilingKey): string[] {
  const other = draft.other[key]
    .split(MULTI_PROFILING_KEYS.has(key) ? "," : /$^/)
    .map((v) => v.trim())
    .filter((v) => v !== "");
  const known = draft.chosen[key].filter((v) => v !== OTHER_CHOICE);
  if (MULTI_PROFILING_KEYS.has(key)) return [...known, ...other];
  return draft.chosen[key].includes(OTHER_CHOICE) ? other.slice(0, 1) : known.slice(0, 1);
}

/** Las cinco obligatorias de `REQUIRED_PROFILING_ANSWERS`; `expectations` es opcional. */
export function missingProfilingAnswers(draft: ProfilingDraft): ProfilingKey[] {
  return PROFILING_KEYS.filter(
    (k) => k !== "expectations" && profilingAnswers(draft, k).length === 0,
  );
}

export function toProfilingRequest(
  draft: ProfilingDraft,
): SubmitOnboardingProfilingRequest {
  const one = (k: ProfilingKey) => profilingAnswers(draft, k)[0] ?? "";
  return {
    ownerRole: one("ownerRole"),
    teamSize: one("teamSize"),
    businessModel: one("businessModel"),
    businessCategories: profilingAnswers(draft, "businessCategories"),
    monthlyRevenueBand: one("monthlyRevenueBand"),
    expectations: profilingAnswers(draft, "expectations"),
  };
}

export function useSubmitProfiling(): UseMutationResult<
  unknown,
  ApiRequestError,
  SubmitOnboardingProfilingRequest
> {
  const queryClient = useQueryClient();
  return useMutation<unknown, ApiRequestError, SubmitOnboardingProfilingRequest>({
    mutationFn: (body) => apiRequest("/onboarding/profiling", { method: "POST", body }),
    retry: false,
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.brandProfile() }),
        queryClient.invalidateQueries({ queryKey: queryKeys.onboarding() }),
      ]),
  });
}

/* ------------------------------------------------------------------------ *
 * Imágenes en el navegador: logo y capturas
 * ------------------------------------------------------------------------ */

/** Lado máximo del logo. Chico a propósito: viaja en `GET /workspaces`. */
export const LOGO_MAX_SIDE = 256;
/** Lado máximo de una captura para OCR: legible y bajo el tope de 700 KB. */
export const SCREENSHOT_MAX_SIDE = 1600;

async function loadImage(file: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Reduce una imagen a `maxSide` y la exporta como `data:` URL. */
export async function downscaleImage(
  file: Blob,
  maxSide: number,
  type: "image/png" | "image/jpeg" | "image/webp",
  quality = 0.85,
): Promise<string> {
  const img = await loadImage(file);
  const scale = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("canvas unavailable");
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL(type, quality);
}

/** Bytes decodificados de un `data:` URL base64. */
export function dataUrlBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(",");
  const b64 = comma === -1 ? "" : dataUrl.slice(comma + 1);
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

export const LOGO_MAX_BYTES = BRAND_LOGO_MAX_BYTES;
export const SCREENSHOT_MAX_BYTES = BRAND_OCR_IMAGE_MAX_BYTES;

export function useUpdateBrandLogo(): UseMutationResult<
  BrandLogo,
  ApiRequestError,
  string | null
> {
  const queryClient = useQueryClient();
  return useMutation<BrandLogo, ApiRequestError, string | null>({
    mutationFn: (dataUrl) =>
      dataUrl === null
        ? apiRequest("/brand/logo", { method: "DELETE", schema: brandLogoSchema })
        : apiRequest("/brand/logo", {
            method: "PUT",
            body: { dataUrl },
            schema: brandLogoSchema,
          }),
    retry: false,
    onSuccess: (logo) => {
      queryClient.setQueryData(intelKeys.logo(), logo);
      // El selector de marca lee el logo de `GET /workspaces`.
      return queryClient.invalidateQueries({ queryKey: brandKeys.workspaces() });
    },
  });
}

export function useReadScreenshot(): UseMutationResult<
  BrandOcrResult,
  ApiRequestError,
  { readonly contentType: "image/jpeg"; readonly data: string }
> {
  return useMutation({
    mutationFn: (body) =>
      apiRequest("/brand/ocr", { method: "POST", body, schema: brandOcrResultSchema }),
    retry: false,
  });
}

/* ------------------------------------------------------------------------ *
 * Content angles
 * ------------------------------------------------------------------------ */

/** Todas las páginas (el cap es 100 por workspace, `FR-056`). */
export function useAngles(): UseQueryResult<ContentAngle[], ApiRequestError> {
  return useQuery<ContentAngle[], ApiRequestError>({
    queryKey: intelKeys.angles(),
    queryFn: async ({ signal }) => {
      const all: ContentAngle[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 5; i += 1) {
        const page: CursorPage<ContentAngle> = await apiList<ContentAngle>(
          "/blitz/angles",
          {
            itemSchema: contentAngleSchema,
            cursor,
            limit: 100,
            signal,
          },
        );
        all.push(...page.items);
        if (!page.hasMore) break;
        cursor = page.cursor;
      }
      return all;
    },
  });
}

function useAngleInvalidation() {
  const queryClient = useQueryClient();
  return () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: intelKeys.angles() }),
      // Crear o desactivar reescribe `angleWeights` en la misma transacción.
      queryClient.invalidateQueries({ queryKey: queryKeys.blitzPreferences() }),
    ]);
}

export function useGenerateAngle(): UseMutationResult<
  GeneratedContentAngle,
  ApiRequestError,
  void
> {
  return useMutation<GeneratedContentAngle, ApiRequestError, void>({
    mutationFn: () =>
      apiRequest("/blitz/angles/generate", {
        method: "POST",
        body: {},
        schema: generatedContentAngleSchema,
      }),
    retry: false,
  });
}

export function useCreateAngle(): UseMutationResult<
  ContentAngle,
  ApiRequestError,
  CreateContentAngleRequest
> {
  const invalidate = useAngleInvalidation();
  return useMutation<ContentAngle, ApiRequestError, CreateContentAngleRequest>({
    mutationFn: (body) =>
      apiRequest("/blitz/angles", { method: "POST", body, schema: contentAngleSchema }),
    retry: false,
    onSuccess: () => invalidate(),
  });
}

export function useUpdateAngle(): UseMutationResult<
  ContentAngle,
  ApiRequestError,
  { readonly id: string; readonly body: UpdateContentAngleRequest }
> {
  const invalidate = useAngleInvalidation();
  return useMutation({
    mutationFn: ({ id, body }) =>
      apiRequest(`/blitz/angles/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body,
        schema: contentAngleSchema,
      }),
    retry: false,
    onSuccess: () => invalidate(),
  });
}

export function useDeleteAngle(): UseMutationResult<void, ApiRequestError, string> {
  const invalidate = useAngleInvalidation();
  return useMutation<void, ApiRequestError, string>({
    mutationFn: (id) =>
      apiSend(`/blitz/angles/${encodeURIComponent(id)}`, { method: "DELETE" }),
    retry: false,
    onSuccess: () => invalidate(),
  });
}

/** `angleWeights` de los ángulos activos: suma exactamente 100 (`FR-055`). */
export function weightsValid(weights: Readonly<Record<string, number>>): boolean {
  const values = Object.values(weights);
  return (
    values.length > 0 &&
    values.every((v) => Number.isInteger(v) && v >= 0 && v <= 100) &&
    values.reduce((a, b) => a + b, 0) === 100
  );
}

export function useSaveAngleWeights(): UseMutationResult<
  BlitzPreferences,
  ApiRequestError,
  Readonly<Record<string, number>>
> {
  const queryClient = useQueryClient();
  return useMutation<BlitzPreferences, ApiRequestError, Readonly<Record<string, number>>>(
    {
      mutationFn: (angleWeights) =>
        apiRequest("/blitz/preferences", {
          method: "PATCH",
          body: { angleWeights },
          schema: blitzPreferencesSchema,
        }),
      retry: false,
      onSuccess: (prefs) => {
        queryClient.setQueryData(queryKeys.blitzPreferences(), prefs);
      },
    },
  );
}
