import type { Metadata } from "next";
import { GlobalLibraryScreen } from "@/components/library/global/GlobalLibraryScreen";
import { tw } from "@/lib/i18n/t";

export const metadata: Metadata = { title: `${tw("globalLibrary.title")} · FastGram` };

/**
 * `/library/assets` · la biblioteca global de assets (sprint 9, N, D-19).
 *
 * Server component fino, como `/library` y `/models`: el `<h1>` lo pone la
 * pantalla (lleva el botón de importar en la cabecera) y todo lo que habla con
 * la API vive en `GlobalLibraryScreen`, que es cliente — `apps/web` no hace
 * fetch desde el servidor (ver `lib/api/client.ts`).
 */
export default function GlobalLibraryPage() {
  return (
    <div className="fgw-page">
      <GlobalLibraryScreen />
    </div>
  );
}
