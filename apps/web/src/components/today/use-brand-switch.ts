"use client";

import { useCallback } from "react";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";

/**
 * "Today" mezcla marcas, pero el resto de la app es de **una**: el detalle de
 * una pieza o el deck de Blitz piden con la cookie de la marca activa, y una
 * pieza de otra marca ahí es un 404. Antes de ir a cualquiera de esas pantallas
 * se cambia a la marca del ítem con el mismo `switchTo` del selector — que
 * resetea la caché y avisa con un toast, así nadie ve datos de una marca bajo
 * el nombre de otra.
 *
 * Sin lista de marcas (modo `standard`, o todavía cargando) no hay a qué
 * cambiar: todo lo que se ve es de la activa.
 */
export function useEnsureBrand(): (brandId: string) => void {
  const { active, workspaces, switchTo } = useWorkspace();
  return useCallback(
    (brandId: string) => {
      if (active === null || active.id === brandId) return;
      const target = workspaces.data?.find((w) => w.id === brandId);
      if (target !== undefined) switchTo(target);
    },
    [active, workspaces.data, switchTo],
  );
}
