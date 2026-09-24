"use client";

/**
 * «Create from prompt» en el deck · `PU-BLITZ-003`, `EXT-009`.
 *
 * Dos llamadas y un polling:
 *
 * | Operación          | Ruta                                  |
 * |--------------------|---------------------------------------|
 * | pedir              | `POST /blitz/generate` → `requestId`  |
 * | en qué quedó       | `GET /blitz/generate/:requestId`      |
 *
 * Las piezas que produce un pedido aparecen **primeras** en `GET /blitz/queue`
 * (el orden lo decide el servidor), con `promptRequestId` para el chip
 * «From your prompt». Así que al terminar no hay que acomodar nada en el
 * cliente: se invalida la cola y listo.
 *
 * El schema del estado es **tolerante** con `failureReason` (string, no enum):
 * un código nuevo del servidor no puede convertir un fallo explicable en un
 * `invalid_response`. Lo que no se reconoce se dibuja con el mensaje genérico.
 */
import {
  BLITZ_PROMPT_MAX_CHARS,
  BLITZ_PROMPT_MAX_COUNT,
  BLITZ_PROMPT_MIN_CHARS,
  type BlitzContentType,
} from "@fastgram/contracts";
import {
  useMutation,
  useQuery,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { z } from "zod";
import { apiRequest } from "../../api/client";
import type { ApiRequestError } from "../../api/errors";
import { ROUTES } from "../../nav/routes";
import type { DeckMessageKey } from "./copy";

export const BLITZ_GENERATE_PATH = "/blitz/generate";
export const blitzPromptStatusPath = (requestId: string): string =>
  `${BLITZ_GENERATE_PATH}/${encodeURIComponent(requestId)}`;

export const blitzPromptStatusKey = (requestId: string) =>
  ["blitz", "prompt", requestId] as const;

/**
 * Cada cuánto se pregunta por un pedido abierto. Una pieza es una llamada al
 * LLM (segundos con un modelo local), así que 2 s muestra el final casi al
 * instante sin martillear la API.
 */
export const PROMPT_POLL_MS = 2_000;

export { BLITZ_PROMPT_MAX_CHARS, BLITZ_PROMPT_MAX_COUNT, BLITZ_PROMPT_MIN_CHARS };

const acceptedSchema = z.object({ requestId: z.string().min(1) });

export const promptStatusSchema = z.object({
  requestId: z.string().min(1),
  status: z.enum(["queued", "running", "done", "failed"]),
  suggestionIds: z.array(z.string()).default([]),
  failureReason: z.string().nullable().optional(),
  count: z.number().int().optional(),
  /**
   * Sprint 7: en qué anda un pedido `running`. `searching_meme` = buscando un
   * meme en YouTube. Tolerante (string): una fase nueva no rompe el polling.
   */
  phase: z.string().nullable().optional(),
});
export type PromptStatus = z.infer<typeof promptStatusSchema>;

export interface GenerateVariables {
  readonly prompt: string;
  /** `null` = lo decide el content mix. */
  readonly contentType: BlitzContentType | null;
  readonly count: number;
  /** Una por intento: el reintento manual del mismo intento la reusa. */
  readonly idempotencyKey: string;
}

/** `POST /blitz/generate` → `requestId`. No cobra. */
export function useGenerateFromPrompt(): UseMutationResult<
  string,
  ApiRequestError,
  GenerateVariables
> {
  return useMutation<string, ApiRequestError, GenerateVariables>({
    mutationFn: async ({ prompt, contentType, count, idempotencyKey }) => {
      const res = await apiRequest<{ requestId: string }>(BLITZ_GENERATE_PATH, {
        method: "POST",
        body: {
          prompt: prompt.trim(),
          ...(contentType === null ? {} : { contentType }),
          count,
        },
        idempotencyKey,
        schema: acceptedSchema,
      });
      return res.requestId;
    },
  });
}

/** ¿Hay que seguir preguntando? Sólo mientras el pedido esté abierto. */
export function promptPollInterval(
  data: PromptStatus | undefined,
  error: unknown,
): number | false {
  if (error !== null && error !== undefined) return false;
  if (data === undefined) return PROMPT_POLL_MS;
  return isOpenPrompt(data) ? PROMPT_POLL_MS : false;
}

export function isOpenPrompt(status: Pick<PromptStatus, "status">): boolean {
  return status.status === "queued" || status.status === "running";
}

/** Sprint 7: ¿el pedido está buscando un meme? (tarda más que la copy). */
export function isSearchingMeme(status: PromptStatus | undefined): boolean {
  return status?.status === "running" && status.phase === "searching_meme";
}

/** `GET /blitz/generate/:requestId`, con polling mientras esté abierto. */
export function useBlitzPromptStatus(
  requestId: string | null,
): UseQueryResult<PromptStatus, ApiRequestError> {
  return useQuery<PromptStatus, ApiRequestError>({
    queryKey: blitzPromptStatusKey(requestId ?? "none"),
    queryFn: ({ signal }) =>
      apiRequest<PromptStatus>(blitzPromptStatusPath(requestId ?? ""), {
        signal,
        schema: promptStatusSchema,
      }),
    enabled: requestId !== null,
    staleTime: 0,
    retry: (failureCount, error) => error.status >= 500 && failureCount < 2,
    refetchInterval: (query) => promptPollInterval(query.state.data, query.state.error),
  });
}

/**
 * Qué decirle al usuario cuando un pedido falla, y adónde mandarlo. Cada
 * código de la API tiene su arreglo: sin modelo → Settings → Models; sin media
 * → la Library, donde se sube y se categoriza.
 */
export interface PromptFailureView {
  readonly message: DeckMessageKey;
  readonly link?: { readonly href: string; readonly label: DeckMessageKey };
}

export function promptFailureView(reason: string | null | undefined): PromptFailureView {
  switch (reason) {
    case "llm_not_configured":
      return {
        message: "prompt.failed.llm",
        link: { href: ROUTES.settingsModels, label: "prompt.failed.llmLink" },
      };
    case "no_media_for_format":
      return {
        message: "prompt.failed.noMediaForFormat",
        link: { href: ROUTES.library, label: "prompt.failed.mediaLink" },
      };
    case "no_media":
      return {
        message: "prompt.failed.noMedia",
        link: { href: ROUTES.library, label: "prompt.failed.mediaLink" },
      };
    case "copy_rejected":
      return { message: "prompt.failed.copyRejected" };
    case "meme_not_found":
      return {
        message: "prompt.failed.memeNotFound",
        link: { href: ROUTES.library, label: "prompt.failed.importLink" },
      };
    case "llm_failed":
      return {
        message: "prompt.failed.llmFailed",
        link: { href: ROUTES.settingsModels, label: "prompt.failed.llmLink" },
      };
    default:
      return { message: "prompt.failed.generic" };
  }
}

/** El tema, validado como lo valida la API (3–500 después de recortar). */
export function promptInputError(value: string): DeckMessageKey | null {
  const trimmed = value.trim();
  if (trimmed.length < BLITZ_PROMPT_MIN_CHARS) return "prompt.tooShort";
  if (trimmed.length > BLITZ_PROMPT_MAX_CHARS) return "prompt.tooLong";
  return null;
}

/** Las cantidades que ofrece el selector: 1…5. */
export const PROMPT_COUNTS: readonly number[] = Array.from(
  { length: BLITZ_PROMPT_MAX_COUNT },
  (_, i) => i + 1,
);
