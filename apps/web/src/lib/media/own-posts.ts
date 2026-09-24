"use client";

/**
 * Importar posts propios al Media Bank · `FR-011.5.1`, D-04, `P1-ONB-008`.
 *
 * Opt-in: el diálogo arranca con el checkbox **desmarcado** y no se importa
 * nada hasta que el usuario lo marca y confirma.
 */
import {
  ownPostImportSchema,
  type OwnPostImport,
  type OwnPostImportRequest,
} from "@fastgram/contracts";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useEffect } from "react";
import { apiRequest } from "../api/client";
import type { ApiRequestError } from "../api/errors";
import { useApiQuery } from "../api/hooks";
import { queryKeys } from "../api/keys";

export const OWN_POSTS_IMPORT_PATH = "/media/own-posts/import";
const POLL_MS = 3_000;

/** Plataformas con lectura oficial cableada (la API las valida igual). */
export const OWN_POST_CONNECTION_PLATFORMS: readonly string[] = ["instagram", "youtube"];

export function isOwnImportSettled(value: OwnPostImport | undefined): boolean {
  return value !== undefined && (value.state === "done" || value.state === "failed");
}

export function useStartOwnPostImport(): UseMutationResult<
  OwnPostImport,
  ApiRequestError,
  OwnPostImportRequest
> {
  return useMutation<OwnPostImport, ApiRequestError, OwnPostImportRequest>({
    mutationFn: (body) =>
      apiRequest<OwnPostImport>(OWN_POSTS_IMPORT_PATH, {
        method: "POST",
        body,
        schema: ownPostImportSchema,
      }),
  });
}

/** Estado con polling hasta que termina; al terminar refresca el Media Bank. */
export function useOwnPostImportStatus(
  id: string | null,
): UseQueryResult<OwnPostImport, ApiRequestError> {
  const queryClient = useQueryClient();
  const query = useApiQuery<OwnPostImport>({
    queryKey: ["media", "own-posts", id ?? ""],
    path: `${OWN_POSTS_IMPORT_PATH}/${encodeURIComponent(id ?? "")}`,
    schema: ownPostImportSchema,
    enabled: id !== null,
    staleTime: 0,
    refetchInterval: (q) => (isOwnImportSettled(q.state.data) ? false : POLL_MS),
  });
  const imported = query.data?.imported ?? 0;
  useEffect(() => {
    if (imported > 0) void queryClient.invalidateQueries({ queryKey: queryKeys.media() });
  }, [imported, queryClient]);
  return query;
}
