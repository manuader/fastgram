"use client";

import type { LibraryAsset } from "@fastgram/contracts";
import { useState } from "react";
import { useUseInBrand } from "@/components/library/global/api";

/**
 * Sprint 9 (T, `PU-S9-015`): elegir de la biblioteca global desde los pickers
 * del editor clásico (`MediaPickerDialog`, `AudioPickerDialog`).
 *
 * Elegir **copia** el asset a la marca activa (`POST /library/assets/{id}/use-in-brand`,
 * N) y le devuelve al editor la URL de la copia: el editor sólo acepta media
 * del Media Bank (o de la biblioteca de audio) de la marca, y el render sólo
 * firma esos prefijos. La biblioteca en sí no se toca.
 *
 * El `Dialog` de `@fastgram/ui` no apila modales: mientras el picker global
 * está abierto, el del editor se oculta (`browsing`), y al cerrarlo vuelve.
 */
export function useGlobalLibraryPick(onPicked: (url: string) => void) {
  const mutation = useUseInBrand();
  const [browsing, setBrowsing] = useState(false);

  const pick = (asset: LibraryAsset) => {
    setBrowsing(false);
    mutation.mutate(asset.id, {
      onSuccess: (result) => {
        onPicked(result.url);
      },
    });
  };

  return {
    browsing,
    open: () => {
      mutation.reset();
      setBrowsing(true);
    },
    close: () => setBrowsing(false),
    pick,
    copying: mutation.isPending,
    failed: mutation.isError,
  };
}
