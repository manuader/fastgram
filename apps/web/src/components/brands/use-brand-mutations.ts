"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { ApiRequestError } from "@/lib/api/errors";
import {
  brandKeys,
  createWorkspace,
  deleteWorkspace,
  renameWorkspace,
  type Workspace,
} from "@/lib/brands/workspaces";

/**
 * Escrituras sobre la lista de marcas.
 *
 * Cada una deja la caché de `["workspaces"]` ya corregida (`setQueryData`)
 * **y** la invalida: lo primero es para que el selector cambie en el mismo
 * frame; lo segundo, para que la verdad la termine diciendo la API (el
 * `profileStatus`, el orden).
 */
export function useCreateWorkspace() {
  const queryClient = useQueryClient();
  return useMutation<Workspace, ApiRequestError, string>({
    mutationFn: (name) => createWorkspace(name),
    onSuccess: (created) => {
      queryClient.setQueryData<Workspace[]>(brandKeys.workspaces(), (current) =>
        current === undefined ? [created] : [...current, created],
      );
      void queryClient.invalidateQueries({ queryKey: brandKeys.workspaces() });
    },
  });
}

export function useRenameWorkspace() {
  const queryClient = useQueryClient();
  return useMutation<Workspace, ApiRequestError, { id: string; name: string }>({
    mutationFn: ({ id, name }) => renameWorkspace(id, name),
    onSuccess: (renamed) => {
      queryClient.setQueryData<Workspace[]>(brandKeys.workspaces(), (current) =>
        current?.map((workspace) => (workspace.id === renamed.id ? renamed : workspace)),
      );
      void queryClient.invalidateQueries({ queryKey: brandKeys.workspaces() });
    },
  });
}

export function useDeleteWorkspace() {
  const queryClient = useQueryClient();
  return useMutation<void, ApiRequestError, string>({
    mutationFn: (id) => deleteWorkspace(id),
    onSuccess: (_void, id) => {
      queryClient.setQueryData<Workspace[]>(brandKeys.workspaces(), (current) =>
        current?.filter((workspace) => workspace.id !== id),
      );
      void queryClient.invalidateQueries({ queryKey: brandKeys.workspaces() });
    },
  });
}
