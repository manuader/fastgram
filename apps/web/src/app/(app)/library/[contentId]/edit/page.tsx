import type { Metadata } from "next";
import { ContentEditor } from "@/components/editor/ContentEditor";

export const metadata: Metadata = { title: "Edit content · FastGram" };

interface PageProps {
  readonly params: Promise<{ readonly contentId: string }>;
}

/**
 * `/library/<contentId>/edit` · el editor de una pieza (`PU-EDIT-003`,
 * FR-051). Cuelga de la vista de la pieza, que es donde su cabecera decía que
 * iba a ir.
 *
 * Igual que la vista: sin validar el id acá. Inexistente y ajeno son el mismo
 * 404 de la API (§9.2), y lo cuenta la pantalla con su camino de vuelta.
 */
export default async function EditContentPage({ params }: PageProps) {
  const { contentId } = await params;
  return (
    <div className="fgw-page">
      <ContentEditor contentId={contentId} />
    </div>
  );
}
