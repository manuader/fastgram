"use client";

/**
 * Paso 1 del onboarding — el input único de Brand Source · `FR-011.1`,
 * `FR-011.2`, `FR-010`, §19.5.1. Tarea `P1-ONB-002`.
 *
 * ## Quién detecta la plataforma: la API, y por qué no este archivo
 *
 * La detección vive en `packages/core/src/brand/source-input.ts`
 * (`detectBrandSource`), con la guarda SSRF adentro. `apps/web` **no puede
 * importarla**: `dependency-cruiser` no lo prohíbe, pero `@fastgram/core` no
 * está en el `package.json` de esta app, y tocar ese archivo no es de esta
 * tarea. Duplicarla sería peor que no tenerla: dos definiciones de "URL segura"
 * que se desincronizan el día que alguien agregue un rango privado a una sola
 * (la cabecera de `apps/api/src/routes/v1/brand.ts` lo dice con esas palabras).
 *
 * Así que el estado `detecting` de `FR-011.8` es literalmente una petición:
 * `POST /brand/sources/resolve`, que el PRD define como *"idempotente y
 * barato"* (PRD:2368) — no escribe ni encola. Se dispara con debounce
 * ({@link RESOLVE_DEBOUNCE_MS}), porque cuenta contra los 60/min de
 * `restPerWorkspace` (§9.6) igual que cualquier otra.
 *
 * ## Lo que los chips pueden y no pueden hacer
 *
 * `FR-011.2`: los chips *"prefijan el input y fijan el `sourceType`"*. Lo
 * primero es texto. Lo segundo viaja como `hint` a `/resolve`, y **sólo** para
 * `Website` (`brandSourceResolveHintSchema` en contracts es `["website"]`):
 *
 * · Para las cinco sociales el prefijo (`instagram.com/`) hace que la URL misma
 *   diga la plataforma. Mandarles `hint` sería además un `400`: el esquema del
 *   request es `.strict()` y el enum no las admite.
 * · Para `Website` sí importa: sin pista, `/resolve` devuelve `other_url` para
 *   cualquier host desconocido (aclaración de `FR-011.1`). Con `hint: "website"`
 *   la API decide `website` —y sólo eso: no convierte una URL de Instagram ni
 *   resuelve un `@handle` suelto—, así que la tarjeta dice lo que va a darse
 *   de alta y el cliente no reinterpreta nada. Ver {@link resolveHintOf}.
 */
import {
  brandSourceSchema,
  brandSourceTypeSchema,
  onboardingStateSchema,
  resolveBrandSourceResponseSchema,
  type BrandSource,
  type BrandSourceResolveHint,
  type BrandSourceType,
  type CreateBrandSourceRequest,
  type OnboardingState,
  type ResolveBrandSourceResponse,
} from "@fastgram/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { CopyKey } from "../i18n/t";
import { apiRequest } from "../api/client";
import {
  presentError,
  brandErrorCodeOf,
  type ErrorPresentation,
} from "../api/error-presentation";
import { isApiRequestError, type ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";
import { newIdempotencyKey } from "../api/idempotency-key";
import { queryKeys } from "../api/keys";
import { onboardingPollInterval } from "./processing";

// ───────────────────────────────────────────────────────────────────────────
// Chips · FR-011.2 (PRD:830)
// ───────────────────────────────────────────────────────────────────────────

/** Los seis chips, en el orden literal del PRD. */
export const CHIP_TYPES = [
  "website",
  "instagram",
  "tiktok",
  "x",
  "youtube",
  "linkedin",
] as const satisfies readonly BrandSourceType[];
export type ChipType = (typeof CHIP_TYPES)[number];

/**
 * Lo que cada chip escribe en el input.
 *
 * **El PRD no los fija**: dice que el chip "prefija", no con qué. Los de acá
 * son las formas de perfil que `detectBrandSource` reconoce como resueltas
 * (ver `source-input.ts`), y hay dos que no son obvias:
 *
 * · TikTok y YouTube llevan la `@`: `tiktok.com/acme` **no** se reconoce
 *   (`detectTikTok` exige `@` en el primer segmento) y `youtube.com/acme` da
 *   `unrecognized`.
 * · LinkedIn lleva `company/`: `linkedin.com/acme` es `unrecognized`. Una
 *   persona (`in/`) tiene que escribirlo a mano; se eligió `company/` porque el
 *   paso es de **marca**.
 *
 * `Website` no prefija: no hay nada que decir antes de un dominio.
 */
export const CHIP_PREFIX: Readonly<Record<ChipType, string>> = {
  website: "",
  instagram: "instagram.com/",
  tiktok: "tiktok.com/@",
  x: "x.com/",
  youtube: "youtube.com/@",
  linkedin: "linkedin.com/company/",
};

const BARE_HANDLE = /^@?[A-Za-z0-9._-]{1,64}$/;

function isChipPrefix(value: string): boolean {
  return CHIP_TYPES.some((c) => CHIP_PREFIX[c] !== "" && CHIP_PREFIX[c] === value);
}

/**
 * El input después de pulsar un chip.
 *
 * · Vacío, o con el prefijo de **otro** chip → el prefijo nuevo.
 * · Un handle suelto (`@acme`, `acme`) → prefijo + handle, sin la `@`. Es el
 *   caso de quien escribe su handle y después aclara la plataforma.
 * · Cualquier otra cosa (ya es una URL) → **no se toca**. Reescribir una URL
 *   pegada sería destruir lo que el usuario puso; el chip igual fija el tipo.
 */
export function applyChip(input: string, chip: ChipType): string {
  const trimmed = input.trim();
  const prefix = CHIP_PREFIX[chip];
  if (trimmed === "" || isChipPrefix(trimmed)) return prefix;
  if (prefix !== "" && BARE_HANDLE.test(trimmed) && !trimmed.includes(".")) {
    return `${prefix}${trimmed.replace(/^@/, "")}`;
  }
  return input;
}

/**
 * La pista que viaja a `/resolve` con el chip activo: `website` o nada.
 *
 * Un chip social **no** manda pista: el enum del contrato no la admite (sería
 * un `400`) y el prefijo ya la dice. Tampoco pisa lo resuelto: si alguien fija
 * Instagram y pega `tiktok.com/@acme`, manda el host (`FR-011.1`), y la
 * tarjeta de confirmación dice TikTok antes de que pulse `Analyse`.
 */
export function resolveHintOf(chip: ChipType | null): BrandSourceResolveHint | undefined {
  return chip === "website" ? "website" : undefined;
}

// ───────────────────────────────────────────────────────────────────────────
// Detección — POST /brand/sources/resolve
// ───────────────────────────────────────────────────────────────────────────

/**
 * Debounce de `/resolve` mientras se escribe.
 *
 * **Número de esta sesión, no del PRD.** El PRD dice "al pegar o escribir" y no
 * da cadencia. 500 ms es lo que tarda en no dispararse a cada tecla: escribir
 * `instagram.com/mimarca` letra a letra con esto es una petición, no veinte.
 */
export const RESOLVE_DEBOUNCE_MS = 500;

/** El desambiguador de `ERR-B03`, leído de los `details` del 400. */
export interface Ambiguity {
  readonly handle: string;
  readonly candidates: readonly BrandSourceType[];
  readonly preselected: BrandSourceType | null;
}

export function ambiguityOf(error: unknown): Ambiguity | null {
  if (brandErrorCodeOf(error) !== "ERR-B03" || !isApiRequestError(error)) return null;
  const details = error.details ?? {};
  const handle = details["handle"];
  const rawCandidates = details["candidates"];
  if (typeof handle !== "string" || !Array.isArray(rawCandidates)) return null;
  const candidates = rawCandidates.flatMap((c) => {
    const parsed = brandSourceTypeSchema.safeParse(c);
    return parsed.success ? [parsed.data] : [];
  });
  if (candidates.length === 0) return null;
  const pre = brandSourceTypeSchema.safeParse(details["preselected"]);
  return {
    handle,
    candidates,
    preselected: pre.success && candidates.includes(pre.data) ? pre.data : null,
  };
}

export type Detection =
  | { readonly kind: "idle" }
  | { readonly kind: "detecting" }
  | {
      readonly kind: "resolved";
      readonly result: ResolveBrandSourceResponse;
      readonly sourceType: BrandSourceType;
    }
  | { readonly kind: "ambiguous"; readonly ambiguity: Ambiguity }
  | { readonly kind: "error"; readonly error: ApiRequestError };

/** El valor, pero sólo cuando dejó de cambiar durante `ms`. */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => {
      setDebounced(value);
    }, ms);
    return () => {
      clearTimeout(id);
    };
  }, [value, ms]);
  return debounced;
}

/**
 * `FR-011.8`: `idle` → `detecting` → `resolved` (o el desambiguador, o un
 * error de entrada).
 *
 * Es un `useQuery` sobre un `POST` y no es un abuso: `/resolve` no escribe
 * nada, y lo que se quiere es exactamente lo que da una query — caché por
 * texto (volver a escribir lo mismo no vuelve a pedir) y cancelación de la
 * petición vieja cuando el texto cambia.
 */
export function useBrandSourceDetection(input: string, chip: ChipType | null): Detection {
  const debounced = useDebouncedValue(input.trim(), RESOLVE_DEBOUNCE_MS);
  const hint = resolveHintOf(chip);
  // Un prefijo de chip sin nada detrás no es una entrada: no se pregunta.
  const ready = debounced !== "" && !isChipPrefix(debounced);

  const query: UseQueryResult<ResolveBrandSourceResponse, ApiRequestError> = useQuery<
    ResolveBrandSourceResponse,
    ApiRequestError
  >({
    // La pista va en la clave: la misma URL con y sin `Website` son dos
    // preguntas distintas (`website` vs `other_url`), y compartir caché
    // serviría la respuesta de la otra al activar o soltar el chip.
    queryKey: queryKeys.brandSourceResolve(debounced, hint),
    queryFn: ({ signal }) =>
      apiRequest("/brand/sources/resolve", {
        method: "POST",
        body: hint === undefined ? { input: debounced } : { input: debounced, hint },
        signal,
        schema: resolveBrandSourceResponseSchema,
      }),
    enabled: ready,
    // La respuesta de un texto no cambia en la sesión salvo por `available`,
    // y `available` lo vuelve a mirar el alta, que es la que decide.
    staleTime: 60_000,
  });

  if (input.trim() === "" || isChipPrefix(input.trim())) return { kind: "idle" };
  // Mientras el texto en pantalla no es el que se preguntó, lo que hay en
  // caché es la respuesta a **otra** entrada: no se muestra.
  if (debounced !== input.trim() || query.isPending) return { kind: "detecting" };
  if (query.isError) {
    const ambiguity = ambiguityOf(query.error);
    return ambiguity === null
      ? { kind: "error", error: query.error }
      : { kind: "ambiguous", ambiguity };
  }
  return {
    kind: "resolved",
    result: query.data,
    sourceType: query.data.sourceType,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Errores de entrada que no traen `ERR-B`
// ───────────────────────────────────────────────────────────────────────────

/**
 * Los tres rechazos SSRF de `FR-010` (PRD:767).
 *
 * La API los manda como `400 bad_request` **sin `details.code`**, con el literal
 * en `message` (`detect` de `brand.ts`). La regla del proyecto es no pintar el
 * `message` del servidor, y no se rompe: lo que se hace es **reconocer** el
 * literal contra una lista cerrada y pintar la clave del catálogo propio. Un
 * mensaje que no esté en la lista sigue cayendo al genérico. Sin esto,
 * `http://localhost` diría *"That request wasn't valid"*, y `FR-010`
 * criterio 2 pide *"cada mensaje de validación … en su condición exacta"*.
 */
const VALIDATION_LITERALS: Readonly<Record<string, CopyKey>> = {
  "Localhost URLs are not allowed": "onboarding.validation.localhost",
  "Private IP addresses are not allowed": "onboarding.validation.privateIp",
  "Blocked URL for security reasons": "onboarding.validation.blocked",
};

/**
 * Presentación de un fallo de `/resolve` o del alta.
 *
 * Por encima de `presentError` (que ya traduce los `ERR-B`), dos casos que la
 * API emite sin `ERR-B`:
 *
 * · SSRF — ver {@link VALIDATION_LITERALS}.
 * · Un **enlace a un post** de Instagram, YouTube o LinkedIn: el handle del
 *   autor no está en la URL y no hay `SocialReader` montado, así que la API
 *   responde `503` con `details.sourceType`. Como `service_unavailable` a secas
 *   diría *"Try again shortly"*, y reintentar no lo arregla nunca: hay que
 *   pegar el perfil.
 */
export function presentSourceInputError(error: unknown): ErrorPresentation {
  if (isApiRequestError(error)) {
    if (
      error.code === "bad_request" &&
      brandErrorCodeOf(error) === null &&
      error.serverMessage !== undefined
    ) {
      const key = VALIDATION_LITERALS[error.serverMessage];
      if (key !== undefined) return { titleKey: key, remedy: "none" };
    }
    if (
      error.code === "service_unavailable" &&
      brandSourceTypeSchema.safeParse(error.details?.["sourceType"]).success
    ) {
      return { titleKey: "onboarding.source.postLinkUnsupported", remedy: "none" };
    }
  }
  return presentError(error);
}

// ───────────────────────────────────────────────────────────────────────────
// Alta — POST /brand/sources
// ───────────────────────────────────────────────────────────────────────────

/**
 * El cuerpo del alta a partir de la detección.
 *
 * Se manda `canonicalUrl` cuando la hay: es la forma que la API vuelve a leer
 * (`detectionInputOf`), y la que conserva mayúsculas donde importan
 * (`channel/UC…` de YouTube). El handle solo va cuando no hay URL.
 */
export function createBodyOf(
  result: ResolveBrandSourceResponse,
  sourceType: BrandSourceType,
): CreateBrandSourceRequest {
  if (result.canonicalUrl !== null)
    return { sourceType, canonicalUrl: result.canonicalUrl };
  return { sourceType, handle: result.handle ?? "" };
}

/**
 * La identidad de un intento, para reusar la `Idempotency-Key`.
 *
 * Mismo cuerpo → misma key: un doble clic en `Analyse`, o un `Try again` tras
 * un timeout, no crean dos fuentes ni encolan dos análisis (§9.14: *"Requiere
 * `Idempotency-Key` porque el análisis tiene coste"*). Cuerpo distinto → key
 * nueva; reusar la vieja con otro cuerpo es un `409` de la capa de idempotencia.
 */
function attemptId(body: CreateBrandSourceRequest): string {
  return `${body.sourceType}|${body.canonicalUrl ?? ""}|${body.handle ?? ""}`;
}

export function useCreateBrandSource(): UseMutationResult<
  BrandSource,
  ApiRequestError,
  CreateBrandSourceRequest
> {
  const queryClient = useQueryClient();
  const keyRef = useRef<{ attempt: string; key: string } | null>(null);

  return useMutation<BrandSource, ApiRequestError, CreateBrandSourceRequest>({
    mutationFn: (body) => {
      const attempt = attemptId(body);
      if (keyRef.current?.attempt !== attempt) {
        keyRef.current = { attempt, key: newIdempotencyKey() };
      }
      return apiRequest("/brand/sources", {
        method: "POST",
        body,
        idempotencyKey: keyRef.current.key,
        schema: brandSourceSchema,
      });
    },
    onSuccess: async () => {
      // Terminado el intento, la key no se vuelve a usar: la próxima fuente
      // —aunque sea la misma, borrada y vuelta a poner— es otro alta.
      keyRef.current = null;
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.onboarding() }),
        queryClient.invalidateQueries({ queryKey: ["brand-sources"] }),
      ]);
    },
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Estado del wizard — GET /onboarding
// ───────────────────────────────────────────────────────────────────────────

/**
 * `GET /onboarding`, con el polling del análisis.
 *
 * Trae las fuentes con su `status`, así que una sola petición cubre todas las
 * fuentes en vez de una por fuente contra `GET /brand/sources/:id`. La
 * cadencia la decide {@link onboardingPollInterval}.
 */
export function useOnboardingState(): UseQueryResult<OnboardingState, ApiRequestError> {
  return useApiQuery<OnboardingState>({
    queryKey: queryKeys.onboarding(),
    path: "/onboarding",
    schema: onboardingStateSchema,
    refetchInterval: (q) => onboardingPollInterval(q.state.data),
  });
}
