import type { Metadata } from "next";
import { ContentDetail } from "@/components/library/ContentDetail";

export const metadata: Metadata = { title: "Content · FastGram" };

interface PageProps {
  readonly params: Promise<{ readonly contentId: string }>;
}

/**
 * `/library/<contentId>` · `GET /content/:id` (§9.3).
 *
 * El PRD no nombra esta ruta en §3.1 —la Library abre la pieza "en el editor"
 * (PRD:1981), que es `P2-STUDIO`—, así que esto es la **vista** de una pieza,
 * no su editor: lo que el contrato v1 permite leer hoy (DATA-008) y nada más.
 * Cuando llegue el editor, esta ruta es el sitio natural donde colgarlo.
 *
 * No hay `generateStaticParams` ni validación del id acá: un id que no existe y
 * uno de otro workspace son **el mismo 404 del API** (§9.2), y ese 404 lo tiene
 * que contar la pantalla, no el router. Un `notFound()` de Next dibujaría el
 * 404 genérico de la app y perdería el camino de vuelta a la Library.
 */
export default async function LibraryContentPage({ params }: PageProps) {
  const { contentId } = await params;
  return (
    <div className="fgw-page">
      <ContentDetail contentId={contentId} />
    </div>
  );
}
