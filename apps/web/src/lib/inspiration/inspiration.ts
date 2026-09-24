"use client";

/**
 * Inspiration como tablero de referencias propio — FR-040 adaptado, OQ-13.
 *
 * | Operación            | Ruta                                  |
 * |----------------------|---------------------------------------|
 * | tablero              | `GET /inspiration` (q, format, tag, page) |
 * | etiquetas en uso     | `GET /inspiration/tags`               |
 * | guardar              | `POST /inspiration` (url o mediaId)   |
 * | borrar               | `DELETE /inspiration/:itemId`         |
 * | «Remix this»         | `POST /inspiration/:itemId/remix`     |
 *
 * El remix devuelve un `requestId` de «crear desde prompt»: el estado se
 * consulta con `useBlitzPromptStatus` (`lib/blitz/deck/prompt.ts`), el mismo
 * polling del deck. Mientras alguna referencia se esté leyendo (`pending`), el
 * tablero se vuelve a pedir cada {@link INSPIRATION_POLL_MS}.
 */
import {
  BLITZ_PROMPT_MIN_CHARS,
  INSPIRATION_MAX_TAGS,
  INSPIRATION_TAG_MAX_CHARS,
  inspirationItemSchema,
  inspirationTagsSchema,
  type BlitzContentType,
  type InspirationFormat,
  type InspirationItem,
} from "@fastgram/contracts";
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { z } from "zod";
import { apiList, apiRequest, apiSend, type CursorPage } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { newIdempotencyKey } from "../api/idempotency-key";
import type { CopyKey } from "../i18n/t";

export const INSPIRATION_PATH = "/inspiration";
export const INSPIRATION_PAGE_SIZE = 24;
/** Leer una página tarda segundos: 3 s se siente vivo sin martillar la API. */
export const INSPIRATION_POLL_MS = 3_000;

export const inspirationKeys = {
  all: ["inspiration"] as const,
  list: (filters: InspirationFilters) => ["inspiration", "list", filters] as const,
  tags: () => ["inspiration", "tags"] as const,
};

export interface InspirationFilters {
  readonly q: string;
  readonly format: InspirationFormat | null;
  readonly tag: string | null;
  readonly page: number;
}

export const EMPTY_FILTERS: InspirationFilters = {
  q: "",
  format: null,
  tag: null,
  page: 1,
};

export function hasActiveFilters(f: InspirationFilters): boolean {
  return f.q.trim() !== "" || f.format !== null || f.tag !== null;
}

export function inspirationQuery(f: InspirationFilters): Record<string, string | number> {
  const out: Record<string, string | number> = {
    page: f.page,
    limit: INSPIRATION_PAGE_SIZE,
  };
  const q = f.q.trim();
  if (q !== "") out["q"] = q;
  if (f.format !== null) out["format"] = f.format;
  if (f.tag !== null) out["tag"] = f.tag;
  return out;
}

export const FORMAT_COPY: Readonly<Record<InspirationFormat, CopyKey>> = {
  video: "inspiration.format.video",
  slideshow: "inspiration.format.slideshow",
  image: "inspiration.format.image",
  text: "inspiration.format.text",
};

export const INSPIRATION_FORMATS: readonly InspirationFormat[] = [
  "video",
  "slideshow",
  "image",
  "text",
];

/** ¿Queda alguna referencia leyéndose? Entonces se vuelve a pedir. */
export function inspirationPollInterval(
  page: CursorPage<InspirationItem> | undefined,
): number | false {
  return page?.items.some((i) => i.ingestState === "pending") === true
    ? INSPIRATION_POLL_MS
    : false;
}

export function useInspirationList(
  filters: InspirationFilters,
): UseQueryResult<CursorPage<InspirationItem>, ApiRequestError> {
  return useQuery<CursorPage<InspirationItem>, ApiRequestError>({
    queryKey: inspirationKeys.list(filters),
    queryFn: ({ signal }) =>
      apiList<InspirationItem>(INSPIRATION_PATH, {
        signal,
        query: inspirationQuery(filters),
        itemSchema: inspirationItemSchema,
      }),
    staleTime: 0,
    placeholderData: (previous) => previous,
    refetchInterval: (q) => inspirationPollInterval(q.state.data),
  });
}

export function useInspirationTags(): UseQueryResult<string[], ApiRequestError> {
  return useQuery<string[], ApiRequestError>({
    queryKey: inspirationKeys.tags(),
    queryFn: ({ signal }) =>
      apiRequest<string[]>(`${INSPIRATION_PATH}/tags`, {
        signal,
        schema: inspirationTagsSchema,
      }),
    staleTime: 30_000,
  });
}

/** `"hooks, POV ,hooks"` → `["hooks", "pov"]`, acotado como la API. */
export function parseTags(raw: string): string[] {
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const tag = part.trim().toLowerCase().slice(0, INSPIRATION_TAG_MAX_CHARS);
    if (tag !== "" && !out.includes(tag)) out.push(tag);
    if (out.length >= INSPIRATION_MAX_TAGS) break;
  }
  return out;
}

export type SaveInspirationVariables =
  | { readonly url: string; readonly tags: readonly string[]; readonly saveClip: boolean }
  | { readonly mediaId: string; readonly tags: readonly string[] };

export function useSaveInspiration(): UseMutationResult<
  InspirationItem,
  ApiRequestError,
  SaveInspirationVariables
> {
  const queryClient = useQueryClient();
  return useMutation<InspirationItem, ApiRequestError, SaveInspirationVariables>({
    mutationFn: (vars) =>
      apiRequest<InspirationItem>(INSPIRATION_PATH, {
        method: "POST",
        body:
          "url" in vars
            ? {
                url: vars.url.trim(),
                ...(vars.tags.length > 0 ? { tags: [...vars.tags] } : {}),
                ...(vars.saveClip ? { saveClip: true } : {}),
              }
            : {
                mediaId: vars.mediaId,
                ...(vars.tags.length > 0 ? { tags: [...vars.tags] } : {}),
              },
        idempotencyKey: newIdempotencyKey(),
        schema: inspirationItemSchema,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inspirationKeys.all });
    },
  });
}

export function useDeleteInspiration(): UseMutationResult<void, ApiRequestError, string> {
  const queryClient = useQueryClient();
  return useMutation<void, ApiRequestError, string>({
    mutationFn: (itemId) =>
      apiSend(`${INSPIRATION_PATH}/${encodeURIComponent(itemId)}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: inspirationKeys.all });
    },
  });
}

export interface RemixVariables {
  readonly itemId: string;
  readonly prompt: string;
  /** `null` = el formato de la referencia o el mix de la marca (lo decide la API). */
  readonly contentType: BlitzContentType | null;
  readonly count: number;
  readonly idempotencyKey: string;
}

const acceptedSchema = z.object({ requestId: z.string().min(1) });

/** `POST /inspiration/:itemId/remix` → `requestId` de «crear desde prompt». */
export function useRemixInspiration(): UseMutationResult<
  string,
  ApiRequestError,
  RemixVariables
> {
  return useMutation<string, ApiRequestError, RemixVariables>({
    mutationFn: async ({ itemId, prompt, contentType, count, idempotencyKey }) => {
      const note = prompt.trim();
      const res = await apiRequest<{ requestId: string }>(
        `${INSPIRATION_PATH}/${encodeURIComponent(itemId)}/remix`,
        {
          method: "POST",
          body: {
            ...(note === "" ? {} : { prompt: note }),
            ...(contentType === null ? {} : { contentType }),
            count,
          },
          idempotencyKey,
          schema: acceptedSchema,
        },
      );
      return res.requestId;
    },
  });
}

/** La nota es opcional; si se escribe, 3–500 como un prompt. */
export function remixNoteError(note: string): "tooShort" | null {
  const t = note.trim();
  return t !== "" && t.length < BLITZ_PROMPT_MIN_CHARS ? "tooShort" : null;
}

/** `1.3M`, `106.8K` — como el overlay de FR-040. */
export function compactCount(n: number): string {
  return new Intl.NumberFormat("en", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(n);
}
