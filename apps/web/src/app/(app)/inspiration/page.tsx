import type { Metadata } from "next";
import { InspirationBoard } from "@/components/inspiration/InspirationBoard";
import { PageHeader } from "@/components/shell/PageHeader";
import { tw } from "@/lib/i18n/t";

export const metadata: Metadata = { title: "Inspiration · FastGram" };

/**
 * `/inspiration` · FR-040 adaptado a uso personal (OQ-13, D-12).
 *
 * No es el catálogo de trending de Fastlane (datos licenciados de terceros,
 * que el clon no replica): es el tablero de referencias que el dueño guarda
 * por link, con búsqueda, filtros y «Remix this» hacia Blitz. Server component
 * fino; lo que habla con la API vive en `InspirationBoard`, que es cliente.
 */
export default function InspirationPage() {
  return (
    <div className="fgw-page">
      <PageHeader
        title={tw("inspiration.title")}
        description={tw("inspiration.subtitle")}
      />
      <InspirationBoard />
    </div>
  );
}
