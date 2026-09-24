"use client";

/**
 * "Extract from a video" · sprint 7, segunda tanda (H).
 *
 * `POST /audio/library/extract` encola; `GET /audio/library/extractions/:id`
 * se pollea hasta `done`/`failed`. Al terminar bien se refresca la
 * biblioteca: la pista (`origin: "extracted"`) la creó el worker.
 */
import {
  AUDIO_EXTRACT_MAX_SECONDS,
  audioExtractionSchema,
  type AudioExtractRequest,
  type AudioExtraction,
} from "@fastgram/contracts";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { apiRequest } from "@/lib/api/client";
import type { ApiRequestError } from "@/lib/api/errors";
import { useApiQuery } from "@/lib/api/hooks";
import { AUDIO_LIBRARY_PATH, audioLibraryKeys } from "@/lib/audio/api";

const POLL_MS = 2_000;

export const AUDIO_EXTRACT_MAX_MINUTES = AUDIO_EXTRACT_MAX_SECONDS / 60;

export function isExtractionSettled(value: AudioExtraction | undefined): boolean {
  return value !== undefined && (value.state === "done" || value.state === "failed");
}

/** ¿El video entra en el tope? Sin duración guardada, se deja intentar (el worker mide). */
export function withinExtractLimit(durationSec: number | undefined): boolean {
  return durationSec === undefined || durationSec <= AUDIO_EXTRACT_MAX_SECONDS + 1;
}

export function useStartAudioExtraction(): UseMutationResult<
  AudioExtraction,
  ApiRequestError,
  AudioExtractRequest
> {
  return useMutation<AudioExtraction, ApiRequestError, AudioExtractRequest>({
    mutationFn: (body) =>
      apiRequest<AudioExtraction>(`${AUDIO_LIBRARY_PATH}/extract`, {
        method: "POST",
        body,
        schema: audioExtractionSchema,
      }),
  });
}

/** Estado con polling hasta que termina; al terminar bien, refresca la biblioteca. */
export function useAudioExtraction(
  id: string | null,
): UseQueryResult<AudioExtraction, ApiRequestError> {
  const queryClient = useQueryClient();
  const query = useApiQuery<AudioExtraction>({
    queryKey: ["audio-library", "extraction", id ?? ""],
    path: `${AUDIO_LIBRARY_PATH}/extractions/${encodeURIComponent(id ?? "")}`,
    schema: audioExtractionSchema,
    enabled: id !== null,
    staleTime: 0,
    refetchInterval: (q) => (isExtractionSettled(q.state.data) ? false : POLL_MS),
  });
  const done = query.data?.state === "done";
  useEffect(() => {
    if (done) void queryClient.invalidateQueries({ queryKey: audioLibraryKeys.all() });
  }, [done, queryClient]);
  return query;
}
