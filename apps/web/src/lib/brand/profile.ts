/**
 * El Company Profile en `/brand` · `FR-020`, `F-022`, `F-025`, DATA-004.
 * Tareas `P1-BRANDPG-001`, `-003`, `-004`.
 *
 * Lógica pura primero (secciones, borrador, patch, procedencia) y los dos
 * hooks al final. Lo puro se prueba sin React en `profile.test.ts`.
 *
 * ## La regla que este archivo existe para no romper
 *
 * **El `PATCH` lleva sólo los campos que el usuario cambió.** No es una
 * optimización: `PATCH /brand/profile` marca `editedByUser: true` en **cada
 * clave del cuerpo** (`markEditedByUser` en `apps/api/src/routes/v1/brand.ts`),
 * y un campo marcado ya no lo toca ningún análisis posterior (`FR-011.6`). Un
 * formulario que mandara la sección entera congelaría para siempre los campos
 * que el usuario ni miró: el próximo re-análisis los propondría en vez de
 * aplicarlos, y hoy no hay pantalla donde ver esas propuestas (ver la nota de
 * `-005` en `BrandProfile.tsx`). Ver {@link buildProfilePatch}.
 *
 * ## `brandRevision` y `expectedBrandRevision` — lo que la API da y lo que no
 *
 * `FR-020`: *"Cada guardado incrementa `brandRevision"*. La API lo hace y lo
 * devuelve; la pantalla lo muestra y lo toma de la respuesta del `PATCH`.
 *
 * `expectedBrandRevision` **se manda** (`P1-BRANDPG-004`, sprint 7): la
 * revisión con la que se abrió la sección. Si otra pestaña o un análisis
 * movieron el perfil, la API responde `409` con
 * `details.reason = "brand_revision_changed"` y la pantalla dice "changed in
 * another tab" ({@link isRevisionConflict}) en vez de pisar. La guarda es del
 * servidor (lectura `FOR UPDATE`), no una comparación del cliente.
 */
import {
  BRAND_FREE_TEXT_ANSWER_MAX,
  companyProfileSchema,
  type BrandSource,
  type CompanyProfile,
  type FieldConfidence,
  type FieldMeta,
  type UpdateCompanyProfileRequest,
} from "@fastgram/contracts";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { CopyKey } from "../i18n/t";
import { apiRequest } from "../api/client";
import { isApiRequestError, type ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";
import { queryKeys } from "../api/keys";
import { BRAND_ANALYSIS_POLL_INTERVAL_MS } from "../onboarding/processing";

// ───────────────────────────────────────────────────────────────────────────
// Campos y secciones · FR-020
// ───────────────────────────────────────────────────────────────────────────

/**
 * Los ocho campos que edita `/brand`: exactamente los que `AI-016` deriva
 * (`BRAND_PROFILE_FIELDS` de `packages/core`, que esta app no puede importar) y
 * los únicos a los que `PATCH /brand/profile` les pone `editedByUser`.
 *
 * Los del cuestionario (`teamSize`, `monthlyRevenueBand`, `ownerRole`,
 * `expectations`, `businessModel`) no están: `FR-020` no los pone en la
 * pantalla y ninguna síntesis los escribe, así que no tienen procedencia que
 * mostrar.
 */
export const PROFILE_FIELDS = [
  "coreIdentity",
  "productOffering",
  "uniqueBenefits",
  "problemSolution",
  "marketAndCompetition",
  "businessCategories",
  "toneOfVoice",
  "targetAudience",
] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];

export const FIELD_LABEL: Readonly<Record<ProfileField, CopyKey>> = {
  coreIdentity: "brand.field.coreIdentity",
  productOffering: "brand.field.productOffering",
  uniqueBenefits: "brand.field.uniqueBenefits",
  problemSolution: "brand.field.problemSolution",
  marketAndCompetition: "brand.field.marketAndCompetition",
  businessCategories: "brand.field.businessCategories",
  toneOfVoice: "brand.field.toneOfVoice",
  targetAudience: "brand.field.targetAudience",
};

export type SectionId = "identity" | "market" | "voice";

export interface ProfileSection {
  readonly id: SectionId;
  readonly titleKey: CopyKey;
  readonly fields: readonly ProfileField[];
}

/**
 * `FR-020` (CONFIRMED): *Identity & Product* con cuatro subcampos y *Market &
 * Competition* con su propio `Edit`. La tercera es la sección INFERRED de tono
 * y audiencia. `businessCategories` va en mercado: es un campo derivado y
 * editable, y el PRD no le da sección.
 */
export const PROFILE_SECTIONS: readonly ProfileSection[] = [
  {
    id: "identity",
    titleKey: "brand.section.identity",
    fields: ["coreIdentity", "productOffering", "uniqueBenefits", "problemSolution"],
  },
  {
    id: "market",
    titleKey: "brand.section.market",
    fields: ["marketAndCompetition", "businessCategories"],
  },
  {
    id: "voice",
    titleKey: "brand.section.voice",
    fields: ["toneOfVoice", "targetAudience"],
  },
];

/** `FR-020` Validation — *"INFERRED límite 4 000 caracteres"*. La API no lo aplica. */
export const PROFILE_FIELD_MAX = BRAND_FREE_TEXT_ANSWER_MAX;

// ───────────────────────────────────────────────────────────────────────────
// Borrador y patch
// ───────────────────────────────────────────────────────────────────────────

/** Lo que hay en los `<textarea>`: todo texto, las categorías separadas por coma. */
export type ProfileDraft = Readonly<Record<ProfileField, string>>;

export function toDraft(profile: CompanyProfile): ProfileDraft {
  return {
    coreIdentity: profile.coreIdentity,
    productOffering: profile.productOffering,
    uniqueBenefits: profile.uniqueBenefits,
    problemSolution: profile.problemSolution,
    marketAndCompetition: profile.marketAndCompetition,
    businessCategories: (profile.businessCategories ?? []).join(", "),
    toneOfVoice: profile.toneOfVoice ?? "",
    targetAudience: profile.targetAudience ?? "",
  };
}

/**
 * `businessCategories` es `text[]`. En pantalla es una lista separada por
 * comas; vacíos y espacios se descartan, que es lo mismo que hace `core` con la
 * salida del modelo (`splitCategories`).
 */
export function parseCategories(text: string): string[] {
  return text
    .split(",")
    .map((c) => c.trim())
    .filter((c) => c !== "");
}

/** El valor de un campo tal como viajaría, para comparar sin ruido de espacios. */
function normalized(field: ProfileField, text: string): string {
  return field === "businessCategories"
    ? parseCategories(text).join("\u0000")
    : text.trim();
}

export function isTooLong(text: string): boolean {
  return text.length > PROFILE_FIELD_MAX;
}

/**
 * El cuerpo del `PATCH` de **una sección**: sólo los campos que cambiaron
 * respecto de la línea base, o `null` si no cambió nada.
 *
 * Ver la cabecera: mandar un campo sin cambios lo marca `editedByUser` y lo
 * saca de los análisis futuros. Por eso "sin cambios" se decide **normalizado**
 * —un espacio al final no es una edición— y el `null` evita un `PATCH` que
 * sólo subiría `brandRevision`.
 */
export function buildProfilePatch(
  baseline: ProfileDraft,
  draft: ProfileDraft,
  fields: readonly ProfileField[],
): UpdateCompanyProfileRequest | null {
  const patch: Record<string, string | string[]> = {};
  for (const field of fields) {
    if (normalized(field, draft[field]) === normalized(field, baseline[field])) continue;
    patch[field] =
      field === "businessCategories"
        ? parseCategories(draft[field])
        : draft[field].trim();
  }
  return Object.keys(patch).length === 0 ? null : (patch as UpdateCompanyProfileRequest);
}

/**
 * `true` si el perfil cambió en el servidor mientras había una sección abierta.
 *
 * Es un **aviso**, no una guarda (ver la cabecera): la pantalla sigue dejando
 * guardar, porque lo que se manda son sólo los campos tocados.
 */
export function revisionMovedDuring(
  startedAtRevision: number,
  current: CompanyProfile | undefined,
): boolean {
  return current !== undefined && current.brandRevision !== startedAtRevision;
}

// ───────────────────────────────────────────────────────────────────────────
// Procedencia y confianza · F-025, FR-011.2
// ───────────────────────────────────────────────────────────────────────────

export type FieldOrigin =
  /** `editedByUser`: lo escribió el usuario. Gana sobre la fuente. */
  | { readonly kind: "edited" }
  | { readonly kind: "source"; readonly source: BrandSource }
  /** `sourceId` apunta a una fuente que ya no está en el listado. */
  | { readonly kind: "removedSource" }
  /** Todavía no llegó el listado de fuentes: no se afirma nada. */
  | { readonly kind: "unknown" }
  /** Sin `fieldMeta`, o sin `sourceId`: no hay origen que mostrar. */
  | { readonly kind: "none" };

/**
 * De dónde salió un campo.
 *
 * `editedByUser` manda aunque haya `sourceId`: `markEditedByUser` **conserva**
 * el `sourceId` y la `confidence` anteriores al marcar la edición, así que
 * después de editar a mano el `fieldMeta` sigue diciendo "de @mimarca, `low`".
 * Pintar eso sobre texto que escribió el usuario sería atribuirle a la fuente
 * algo que no dijo. Ver también {@link confidenceOf}.
 *
 * Una fuente borrada no revierte el perfil (`FR-011.11`), así que un `sourceId`
 * huérfano es normal y se dice como tal en vez de ocultarlo.
 */
export function fieldOrigin(
  meta: FieldMeta | undefined,
  sources: readonly BrandSource[] | undefined,
): FieldOrigin {
  if (meta === undefined) return { kind: "none" };
  if (meta.editedByUser) return { kind: "edited" };
  if (meta.sourceId === null) return { kind: "none" };
  if (sources === undefined) return { kind: "unknown" };
  const source = sources.find((s) => s._id === meta.sourceId);
  return source === undefined ? { kind: "removedSource" } : { kind: "source", source };
}

/**
 * La confianza que se muestra, o `null` si no corresponde mostrar ninguna.
 *
 * En un campo editado a mano no se muestra: la confianza de `FR-011.2` es *"si
 * el extracto respalda el valor"*, y el valor ya no sale de ningún extracto.
 */
export function confidenceOf(meta: FieldMeta | undefined): FieldConfidence | null {
  if (meta === undefined || meta.editedByUser) return null;
  return meta.confidence;
}

/** Las fuentes que contradicen el valor elegido (`FR-011.6`), las que aún existen. */
export function conflictingSources(
  meta: FieldMeta | undefined,
  sources: readonly BrandSource[] | undefined,
): readonly BrandSource[] {
  if (meta?.conflictsWith === undefined || sources === undefined) return [];
  const ids = new Set<string>(meta.conflictsWith);
  return sources.filter((s) => ids.has(s._id));
}

/**
 * `Worth a quick check` (`FR-011.2`): los campos con confianza `low`, en el
 * orden de la pantalla. Los editados a mano no — ver {@link confidenceOf}.
 */
export function worthAQuickCheck(profile: CompanyProfile): readonly ProfileField[] {
  return PROFILE_FIELDS.filter(
    (field) => confidenceOf(profile.fieldMeta[field]) === "low",
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Red
// ───────────────────────────────────────────────────────────────────────────

/**
 * `GET /brand/profile`.
 *
 * `poll` lo decide quien tiene el listado de fuentes: mientras alguna está en
 * `pending`/`analyzing`, el análisis va a escribir el perfil cuando termine y
 * la pantalla tiene que enterarse. Sin fuentes en curso no se consulta: el
 * perfil sólo cambia por una edición de esta misma pantalla, que ya actualiza
 * la caché con la respuesta.
 */
export function useBrandProfile(
  poll: boolean,
): UseQueryResult<CompanyProfile, ApiRequestError> {
  return useApiQuery<CompanyProfile>({
    queryKey: queryKeys.brandProfile(),
    path: "/brand/profile",
    schema: companyProfileSchema,
    refetchInterval: poll ? BRAND_ANALYSIS_POLL_INTERVAL_MS : false,
  });
}

/**
 * `PATCH /brand/profile`. La respuesta es el perfil completo con la
 * `brandRevision` nueva, así que se escribe en la caché en vez de invalidar:
 * un `GET` más no aporta nada y gasta el límite de §9.6.
 */
export function useSaveBrandProfile(): UseMutationResult<
  CompanyProfile,
  ApiRequestError,
  UpdateCompanyProfileRequest
> {
  const queryClient = useQueryClient();
  return useMutation<CompanyProfile, ApiRequestError, UpdateCompanyProfileRequest>({
    mutationFn: (body) =>
      apiRequest("/brand/profile", {
        method: "PATCH",
        body,
        schema: companyProfileSchema,
      }),
    retry: false,
    onSuccess: (saved) => {
      queryClient.setQueryData<CompanyProfile>(queryKeys.brandProfile(), saved);
    },
  });
}

/** `409` de `PATCH /brand/profile` o de una propuesta: el perfil se movió. */
export function isRevisionConflict(error: unknown): boolean {
  return (
    isApiRequestError(error) &&
    error.status === 409 &&
    error.details?.["reason"] === "brand_revision_changed"
  );
}
