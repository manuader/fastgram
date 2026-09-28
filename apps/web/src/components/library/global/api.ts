"use client";

/**
 * Hooks de la biblioteca **global** de assets — sprint 9 (agente N), D-19.
 *
 * Casi todas las rutas son **del dueño** (`/library/assets…`,
 * `/library/sources…`): la API ignora la marca activa. Por eso las claves de
 * caché no llevan la marca, y cambiar de marca no obliga a volver a pedir la
 * biblioteca. La excepción es `use-in-brand`, que escribe en la marca activa:
 * ésa sí invalida las claves del Media Bank y del audio de la marca.
 *
 * Las funciones puras (`libraryListQuery`, `licenseDeclarationFrom`,
 * `detailPatch`…) viven acá y no en los componentes para que los tests las
 * ejerciten sin montar nada.
 */
import {
  LIBRARY_ATTRIBUTION_REQUIRED,
  LIBRARY_UPLOAD_CONTENT_TYPES,
  LIBRARY_UPLOAD_MAX_MB,
  libraryAssetSchema,
  libraryLicenseDeclarationSchema,
  librarySearchPageSchema,
  librarySourceImportResultSchema,
  librarySourceStatusListSchema,
  librarySourceStatusSchema,
  libraryUploadRequestSchema,
  libraryUploadReservationSchema,
  libraryUseInBrandResultSchema,
  type LibraryAsset,
  type LibraryAssetKind,
  type LibraryAssetStatus,
  type LibraryAspectRatio,
  type LibraryEmotion,
  type LibraryLicenseDeclaration,
  type LibraryLicenseType,
  type LibraryMemeType,
  type LibrarySearchPage,
  type LibrarySourceId,
  type LibrarySourceImportOutcome,
  type LibrarySourceImportRequest,
  type LibrarySourceStatus,
  type LibraryUploadRequest,
  type LibraryUploadReservation,
  type LibraryUseInBrandResult,
  type UpdateLibraryAssetRequest,
} from "@fastgram/contracts";
import {
  useMutation,
  useQueryClient,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";

import { apiRequest, apiSend, type QueryParams } from "@/lib/api/client";
import type { ApiRequestError } from "@/lib/api/errors";
import { useApiInfiniteQuery, useApiQuery, type CursorPages } from "@/lib/api/hooks";
import { queryKeys } from "@/lib/api/keys";
import { audioLibraryKeys } from "@/lib/audio/api";
import { putSignedUpload, type UploadProgress } from "@/lib/media/upload/transport";

export const LIBRARY_ASSETS_PATH = "/library/assets";
export const LIBRARY_SOURCES_PATH = "/library/sources";
/** Un asset en `processing` tarda segundos (normalizar + etiquetar): 4 s alcanza. */
export const LIBRARY_PROCESSING_POLL_MS = 4_000;
/** Una página del contrato (`limit` default 40). */
export const LIBRARY_PAGE_SIZE = 40;

export const libraryKeys = {
  all: () => ["global-library"] as const,
  lists: () => ["global-library", "list"] as const,
  list: (query: QueryParams) => ["global-library", "list", query] as const,
  one: (id: string) => ["global-library", "asset", id] as const,
  sources: () => ["global-library", "sources"] as const,
  search: (source: string, q: string, page: number) =>
    ["global-library", "search", source, q, page] as const,
};

const assetPath = (id: string, rest = ""): string =>
  `${LIBRARY_ASSETS_PATH}/${encodeURIComponent(id)}${rest}`;
const sourcePath = (source: LibrarySourceId, rest = ""): string =>
  `${LIBRARY_SOURCES_PATH}/${encodeURIComponent(source)}${rest}`;

/* ── Listado ── */

export interface LibraryFilters {
  readonly q: string;
  readonly kinds: readonly LibraryAssetKind[];
  readonly memeType: LibraryMemeType | null;
  readonly emotion: LibraryEmotion | null;
  readonly aspect: LibraryAspectRatio | null;
  readonly license: LibraryLicenseType | null;
  readonly maxDuration: number | null;
  /** `null` = el default del servidor (`processing` + `ready`). */
  readonly statuses: readonly LibraryAssetStatus[] | null;
}

export const EMPTY_LIBRARY_FILTERS: LibraryFilters = {
  q: "",
  kinds: [],
  memeType: null,
  emotion: null,
  aspect: null,
  license: null,
  maxDuration: null,
  statuses: null,
};

/** Todo lo que el dueño puede ver, incluido lo oculto y lo fallido. */
export const ALL_LIBRARY_STATUSES: readonly LibraryAssetStatus[] = [
  "ready",
  "processing",
  "failed",
  "hidden",
];

/**
 * Los filtros como query del contrato (listas en CSV). Lo vacío **no** viaja:
 * un `kind=` vacío lo rechaza el `csv()` del schema de la API, y además
 * cambiaría la clave de caché sin cambiar el resultado.
 */
export function libraryListQuery(filters: LibraryFilters): QueryParams {
  const q = filters.q.trim();
  const out: Record<string, string | number> = {};
  if (q !== "") out["q"] = q;
  if (filters.kinds.length > 0) out["kind"] = filters.kinds.join(",");
  if (filters.memeType !== null) out["memeType"] = filters.memeType;
  if (filters.emotion !== null) out["emotion"] = filters.emotion;
  if (filters.aspect !== null) out["aspect"] = filters.aspect;
  if (filters.license !== null) out["license"] = filters.license;
  if (filters.maxDuration !== null) out["maxDuration"] = filters.maxDuration;
  if (filters.statuses !== null && filters.statuses.length > 0) {
    out["status"] = filters.statuses.join(",");
  }
  return out;
}

export function flattenLibraryPages(
  data: CursorPages<LibraryAsset> | undefined,
): LibraryAsset[] {
  return data?.pages.flatMap((page) => [...page.items]) ?? [];
}

export function isProcessing(asset: Pick<LibraryAsset, "status">): boolean {
  return asset.status === "processing";
}

/**
 * `GET /library/assets`, paginado por cursor. Mientras haya algo procesando se
 * refresca cada 4 s y se apaga solo: refetchear un listado infinito vuelve a
 * pedir todas las páginas abiertas (ver `useApiInfiniteQuery`).
 */
export function useLibraryAssets(
  filters: LibraryFilters,
  options: { readonly enabled?: boolean } = {},
): UseInfiniteQueryResult<CursorPages<LibraryAsset>, ApiRequestError> {
  const query = libraryListQuery(filters);
  return useApiInfiniteQuery<LibraryAsset>({
    queryKey: libraryKeys.list(query),
    path: LIBRARY_ASSETS_PATH,
    query,
    itemSchema: libraryAssetSchema,
    limit: LIBRARY_PAGE_SIZE,
    ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    refetchInterval: (q) =>
      q.state.data?.pages.some((page) => page.items.some(isProcessing)) === true
        ? LIBRARY_PROCESSING_POLL_MS
        : false,
  });
}

/** `GET /library/assets/{id}` — el detalle, con polling mientras procesa. */
export function useLibraryAsset(
  id: string | null,
): UseQueryResult<LibraryAsset, ApiRequestError> {
  return useApiQuery<LibraryAsset>({
    queryKey: libraryKeys.one(id ?? "none"),
    path: assetPath(id ?? "none"),
    schema: libraryAssetSchema,
    enabled: id !== null,
    refetchInterval: (q) =>
      q.state.data !== undefined && isProcessing(q.state.data)
        ? LIBRARY_PROCESSING_POLL_MS
        : false,
  });
}

function useSetAsset() {
  const queryClient = useQueryClient();
  return (asset: LibraryAsset) => {
    queryClient.setQueryData(libraryKeys.one(asset.id), asset);
    void queryClient.invalidateQueries({ queryKey: libraryKeys.lists() });
  };
}

export function useUpdateLibraryAsset(
  id: string,
): UseMutationResult<LibraryAsset, ApiRequestError, UpdateLibraryAssetRequest> {
  const setAsset = useSetAsset();
  return useMutation<LibraryAsset, ApiRequestError, UpdateLibraryAssetRequest>({
    mutationFn: (body) =>
      apiRequest<LibraryAsset>(assetPath(id), {
        method: "PATCH",
        body,
        schema: libraryAssetSchema,
      }),
    onSuccess: setAsset,
  });
}

export function useDeleteLibraryAsset(
  id: string,
): UseMutationResult<void, ApiRequestError, void> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiRequestError, void>({
    mutationFn: async () => {
      await apiSend(assetPath(id), { method: "DELETE" });
    },
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: libraryKeys.one(id) });
      void queryClient.invalidateQueries({ queryKey: libraryKeys.lists() });
    },
  });
}

/**
 * `POST /library/assets/{id}/use-in-brand` — la única ruta de marca: copia el
 * asset al Media Bank (o al audio) de la **marca activa**. Por eso invalida
 * las claves de la marca y no las de la biblioteca.
 */
export function useUseInBrand(): UseMutationResult<
  LibraryUseInBrandResult,
  ApiRequestError,
  string
> {
  const queryClient = useQueryClient();
  return useMutation<LibraryUseInBrandResult, ApiRequestError, string>({
    mutationFn: (id) =>
      apiRequest<LibraryUseInBrandResult>(assetPath(id, "/use-in-brand"), {
        method: "POST",
        body: {},
        schema: libraryUseInBrandResultSchema,
      }),
    onSuccess: (result) => {
      if (result.target === "audio") {
        void queryClient.invalidateQueries({ queryKey: audioLibraryKeys.all() });
      } else {
        // `queryKeys.media()` cuelga de `["media"]`: el prefijo alcanza a todos
        // los filtros abiertos del Media Bank.
        void queryClient.invalidateQueries({ queryKey: [queryKeys.media()[0]] });
      }
    },
  });
}

/* ── Subida manual (reserva → PUT → complete) ── */

/** Lo que el formulario de licencia guarda: strings, `""` = sin completar. */
export interface LicenseForm {
  readonly type: LibraryLicenseType | "";
  readonly version: string;
  readonly author: string;
  readonly attribution: string;
  readonly sourceUrl: string;
  readonly licenseUrl: string;
}

export const EMPTY_LICENSE_FORM: LicenseForm = {
  type: "",
  version: "",
  author: "",
  attribution: "",
  sourceUrl: "",
  licenseUrl: "",
};

export type LicenseField = keyof LicenseForm;
export type LicenseFieldError = "required" | "invalid";

/**
 * Copia de `THIRD_PARTY` del contrato (no se exporta): las licencias de un
 * tercero no se pueden verificar sin la página del archivo y la de la
 * licencia. Si cambia allá, cambia acá; el servidor igual valida.
 */
export const LIBRARY_THIRD_PARTY_LICENSES: readonly LibraryLicenseType[] = [
  "cc0",
  "cc-by",
  "pexels",
  "pixabay",
];

/** Qué campos exige cada tipo, para marcar el `*` y validar. */
export function requiredLicenseFields(
  type: LibraryLicenseType | "",
): readonly LicenseField[] {
  if (type === "") return ["type"];
  const out: LicenseField[] = [];
  if (LIBRARY_ATTRIBUTION_REQUIRED.includes(type)) out.push("attribution");
  if (LIBRARY_THIRD_PARTY_LICENSES.includes(type)) out.push("sourceUrl", "licenseUrl");
  return out;
}

export type LicenseCheck =
  | { readonly ok: true; readonly value: LibraryLicenseDeclaration }
  | {
      readonly ok: false;
      readonly errors: Partial<Record<LicenseField, LicenseFieldError>>;
    };

/**
 * La declaración de licencia, o por qué no alcanza. El schema del contrato
 * (`libraryLicenseDeclarationSchema`) valida forma (URLs, largos) pero no los
 * obligatorios por tipo —ésos están en `libraryLicenseSchema`, que exige un
 * `verifiedAt` que pone el servidor—, así que la regla por tipo va acá.
 */
export function licenseDeclarationFrom(form: LicenseForm): LicenseCheck {
  const errors: Partial<Record<LicenseField, LicenseFieldError>> = {};
  if (form.type === "") return { ok: false, errors: { type: "required" } };

  const trimmed = {
    version: form.version.trim(),
    author: form.author.trim(),
    attribution: form.attribution.trim(),
    sourceUrl: form.sourceUrl.trim(),
    licenseUrl: form.licenseUrl.trim(),
  };
  for (const field of requiredLicenseFields(form.type)) {
    if (field !== "type" && trimmed[field] === "") errors[field] = "required";
  }

  const candidate: Record<string, string> = { type: form.type };
  for (const [key, value] of Object.entries(trimmed)) {
    if (value !== "") candidate[key] = value;
  }
  const parsed = libraryLicenseDeclarationSchema.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (
        typeof field === "string" &&
        field in trimmed &&
        errors[field as LicenseField] === undefined
      ) {
        errors[field as LicenseField] = "invalid";
      }
    }
  }
  if (Object.keys(errors).length > 0 || !parsed.success) {
    return { ok: false, errors };
  }
  return { ok: true, value: parsed.data };
}

export type LibraryFileRejection = "empty" | "too_large" | "unsupported_type";

/**
 * El content type que se declara: el del navegador si es uno de los aceptados,
 * si no el que corresponde a la extensión (Safari y Windows a veces no ponen
 * `type` a un `.mov` o un `.m4a`).
 */
export function libraryContentTypeFor(file: {
  readonly name: string;
  readonly type: string;
}): string | null {
  if (file.type in LIBRARY_UPLOAD_CONTENT_TYPES) return file.type;
  const lower = file.name.toLowerCase();
  for (const [type, exts] of Object.entries(LIBRARY_UPLOAD_CONTENT_TYPES)) {
    if (exts.some((ext) => lower.endsWith(ext))) return type;
  }
  return null;
}

export function checkLibraryFile(file: {
  readonly name: string;
  readonly type: string;
  readonly size: number;
}): LibraryFileRejection | null {
  if (file.size <= 0) return "empty";
  if (libraryContentTypeFor(file) === null) return "unsupported_type";
  if (file.size > LIBRARY_UPLOAD_MAX_MB * 1024 * 1024) return "too_large";
  return null;
}

/** El `accept` del input: content types y extensiones (ver `lib/media/upload/policy.ts`). */
export const LIBRARY_UPLOAD_ACCEPT = [
  ...Object.keys(LIBRARY_UPLOAD_CONTENT_TYPES),
  ...Object.values(LIBRARY_UPLOAD_CONTENT_TYPES).flat(),
].join(",");

/** El cuerpo de la reserva, validado con el schema del contrato, o `null`. */
export function libraryUploadRequest(
  file: { readonly name: string; readonly type: string; readonly size: number },
  extra: {
    readonly title: string;
    readonly kind: LibraryAssetKind | "";
    readonly license: LibraryLicenseDeclaration;
  },
): LibraryUploadRequest | null {
  const contentType = libraryContentTypeFor(file);
  if (contentType === null) return null;
  const title = extra.title.trim();
  const parsed = libraryUploadRequestSchema.safeParse({
    filename: file.name,
    contentType,
    sizeBytes: file.size,
    license: extra.license,
    ...(title === "" ? {} : { title }),
    ...(extra.kind === "" ? {} : { kind: extra.kind }),
  });
  return parsed.success ? parsed.data : null;
}

export type LibraryUploadStep = "reserve" | "transfer" | "finalize";

export interface LibraryUploadVariables {
  readonly file: Blob;
  readonly body: LibraryUploadRequest;
  readonly onProgress?: UploadProgress;
  readonly onStep?: (step: LibraryUploadStep) => void;
  readonly signal?: AbortSignal;
}

/**
 * Los tres pasos de §9.8 en una sola mutación: acá no hay cola ni reintento
 * por paso (es una subida por vez, desde un formulario), así que un fallo se
 * reintenta desde el principio, que es gratis.
 */
export function useLibraryUpload(): UseMutationResult<
  LibraryAsset,
  unknown,
  LibraryUploadVariables
> {
  const setAsset = useSetAsset();
  return useMutation<LibraryAsset, unknown, LibraryUploadVariables>({
    mutationFn: async ({ file, body, onProgress, onStep, signal }) => {
      onStep?.("reserve");
      const reservation = await apiRequest<LibraryUploadReservation>(
        `${LIBRARY_ASSETS_PATH}/uploads`,
        {
          method: "POST",
          body,
          schema: libraryUploadReservationSchema,
          ...(signal === undefined ? {} : { signal }),
        },
      );
      onStep?.("transfer");
      await putSignedUpload({
        url: reservation.uploadUrl,
        method: reservation.method,
        headers: reservation.headers,
        body: file,
        onProgress,
        signal,
      });
      onStep?.("finalize");
      return apiRequest<LibraryAsset>(
        `${LIBRARY_ASSETS_PATH}/uploads/${encodeURIComponent(reservation.uploadId)}/complete`,
        {
          method: "POST",
          body: {},
          schema: libraryAssetSchema,
          ...(signal === undefined ? {} : { signal }),
        },
      );
    },
    onSuccess: setAsset,
  });
}

/* ── Fuentes externas ── */

export function useLibrarySources(
  enabled = true,
): UseQueryResult<LibrarySourceStatus[], ApiRequestError> {
  return useApiQuery<LibrarySourceStatus[]>({
    queryKey: libraryKeys.sources(),
    path: LIBRARY_SOURCES_PATH,
    schema: librarySourceStatusListSchema,
    enabled,
  });
}

function useSetSource() {
  const queryClient = useQueryClient();
  return (status: LibrarySourceStatus) => {
    queryClient.setQueryData<LibrarySourceStatus[]>(libraryKeys.sources(), (old) =>
      (old ?? []).map((s) => (s.id === status.id ? status : s)),
    );
    // Una búsqueda cacheada con la key vieja ya no sirve.
    void queryClient.invalidateQueries({
      queryKey: ["global-library", "search", status.id],
    });
  };
}

/** `PUT /library/sources/{source}/key`. La key nunca vuelve: sólo el estado. */
export function useSetSourceKey(): UseMutationResult<
  LibrarySourceStatus,
  ApiRequestError,
  { readonly source: LibrarySourceId; readonly apiKey: string }
> {
  const setSource = useSetSource();
  return useMutation<
    LibrarySourceStatus,
    ApiRequestError,
    { readonly source: LibrarySourceId; readonly apiKey: string }
  >({
    mutationFn: ({ source, apiKey }) =>
      apiRequest<LibrarySourceStatus>(sourcePath(source, "/key"), {
        method: "PUT",
        body: { apiKey },
        schema: librarySourceStatusSchema,
      }),
    onSuccess: setSource,
  });
}

export function useDeleteSourceKey(): UseMutationResult<
  LibrarySourceStatus,
  ApiRequestError,
  LibrarySourceId
> {
  const setSource = useSetSource();
  return useMutation<LibrarySourceStatus, ApiRequestError, LibrarySourceId>({
    mutationFn: (source) =>
      apiRequest<LibrarySourceStatus>(sourcePath(source, "/key"), {
        method: "DELETE",
        schema: librarySourceStatusSchema,
      }),
    onSuccess: setSource,
  });
}

/** `GET /library/sources/{source}/search`. Sólo corre con un término y la fuente lista. */
export function useLibrarySearch(
  source: LibrarySourceId | null,
  q: string,
  page: number,
): UseQueryResult<LibrarySearchPage, ApiRequestError> {
  const term = q.trim();
  return useApiQuery<LibrarySearchPage>({
    queryKey: libraryKeys.search(source ?? "none", term, page),
    path: sourcePath(source ?? "wikimedia", "/search"),
    query: { q: term, page },
    schema: librarySearchPageSchema,
    enabled: source !== null && term !== "",
    // Una búsqueda en una fuente externa cuesta cuota de su API: no se repite
    // por foco ni por remontar el diálogo.
    staleTime: 5 * 60_000,
  });
}

export function useImportFromSource(): UseMutationResult<
  LibrarySourceImportOutcome[],
  ApiRequestError,
  { readonly source: LibrarySourceId; readonly body: LibrarySourceImportRequest }
> {
  const queryClient = useQueryClient();
  return useMutation<
    LibrarySourceImportOutcome[],
    ApiRequestError,
    { readonly source: LibrarySourceId; readonly body: LibrarySourceImportRequest }
  >({
    mutationFn: ({ source, body }) =>
      apiRequest<LibrarySourceImportOutcome[]>(sourcePath(source, "/import"), {
        method: "POST",
        body,
        schema: librarySourceImportResultSchema,
      }),
    onSuccess: (_outcomes, { source }) => {
      void queryClient.invalidateQueries({ queryKey: libraryKeys.lists() });
      // `existingAssetId` de los resultados cambió para lo que se acaba de importar.
      void queryClient.invalidateQueries({
        queryKey: ["global-library", "search", source],
      });
    },
  });
}

/* ── Formulario de metadatos ── */

/** El formulario del detalle. Lo medido y la licencia no están: no se editan. */
export interface AssetDetailForm {
  readonly title: string;
  readonly kind: LibraryAssetKind;
  readonly description: string;
  readonly memeType: LibraryMemeType | null;
  readonly emotions: readonly LibraryEmotion[];
  readonly useCases: readonly string[];
  readonly characters: readonly string[];
  readonly tags: readonly string[];
  readonly language: string;
  readonly hasSpeech: boolean;
  readonly framing: NonNullable<LibraryAsset["metadata"]>["framing"] | null;
  readonly energy: NonNullable<LibraryAsset["metadata"]>["energy"] | null;
}

export function detailFormFrom(asset: LibraryAsset): AssetDetailForm {
  const m = asset.metadata;
  return {
    title: asset.title,
    kind: asset.kind,
    description: m?.description ?? "",
    memeType: m?.memeType ?? null,
    emotions: m?.emotions ?? [],
    useCases: m?.useCases ?? [],
    characters: m?.characters ?? [],
    tags: m?.tags ?? [],
    language: m?.language ?? "",
    hasSpeech: m?.hasSpeech ?? false,
    framing: m?.framing ?? null,
    energy: m?.energy ?? null,
  };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * El `PATCH` con **sólo lo que cambió**. Mandar el formulario entero pisaría
 * con lo que había en pantalla un cambio que otro hizo mientras tanto (el
 * worker re-etiquetando, por ejemplo), y además convertiría cualquier guardado
 * en «editado» aunque no se haya tocado nada.
 *
 * Sin metadatos (un asset que todavía procesa o que falló) sólo viajan
 * `title` y `kind`: el resto no tiene contra qué compararse.
 */
export function detailPatch(
  asset: LibraryAsset,
  form: AssetDetailForm,
): UpdateLibraryAssetRequest {
  const patch: UpdateLibraryAssetRequest = {};
  const title = form.title.trim();
  if (title !== "" && title !== asset.title) patch.title = title;
  if (form.kind !== asset.kind) patch.kind = form.kind;

  const m = asset.metadata;
  if (m === null) return patch;

  const description = form.description.trim();
  if (description !== m.description) patch.description = description;
  if (form.memeType !== null && form.memeType !== m.memeType)
    patch.memeType = form.memeType;
  if (!sameList(form.emotions, m.emotions)) patch.emotions = [...form.emotions];
  if (!sameList(form.useCases, m.useCases)) patch.useCases = [...form.useCases];
  if (!sameList(form.characters, m.characters)) patch.characters = [...form.characters];
  if (!sameList(form.tags, m.tags)) patch.tags = [...form.tags];
  if (form.hasSpeech !== m.hasSpeech) patch.hasSpeech = form.hasSpeech;
  // El contrato rechaza un idioma sin habla: apagar el habla limpia el idioma.
  const language = form.hasSpeech ? form.language.trim() || null : null;
  if (language !== m.language) patch.language = language;
  if (form.framing !== null && form.framing !== m.framing) patch.framing = form.framing;
  if (form.energy !== null && form.energy !== m.energy) patch.energy = form.energy;
  return patch;
}
