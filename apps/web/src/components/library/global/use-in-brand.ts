"use client";

import { useToast } from "@fastgram/ui";
import { useState } from "react";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";
import { presentError } from "@/lib/api/error-presentation";
import { tw } from "@/lib/i18n/t";
import { useUseInBrand } from "./api";

/**
 * «Use in brand» con su confirmación: el toast dice **en qué marca** quedó,
 * porque la biblioteca se ve igual desde cualquier marca y es fácil copiar a
 * la que no era. Además se recuerda qué asset se copió, para que la tarjeta o
 * el detalle lo digan en línea (el toast se va; la marca en la tarjeta queda).
 */
export function useUseInBrandFlow() {
  const mutation = useUseInBrand();
  const { toast } = useToast();
  const { active } = useWorkspace();
  const brand = active?.name ?? "—";
  const [addedIds, setAddedIds] = useState<readonly string[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const run = (assetId: string) => {
    setPendingId(assetId);
    mutation.mutate(assetId, {
      onSuccess: (result) => {
        setAddedIds((ids) => (ids.includes(assetId) ? ids : [...ids, assetId]));
        toast({
          tone: "success",
          title: tw(
            result.target === "audio"
              ? "globalLibrary.useInBrand.doneAudio"
              : "globalLibrary.useInBrand.doneMedia",
            { brand },
          ),
        });
      },
      onError: (error) => {
        const p = presentError(error);
        toast({
          tone: "danger",
          title: tw("globalLibrary.useInBrand.failed"),
          description: tw(p.titleKey, p.titleVars),
        });
      },
      onSettled: () => {
        setPendingId(null);
      },
    });
  };

  return { run, brand, addedIds, pendingId };
}
