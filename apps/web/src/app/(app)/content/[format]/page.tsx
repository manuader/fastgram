import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageHeader } from "@/components/shell/PageHeader";
import { CustomVideoUpload } from "@/components/studio/CustomVideoUpload";
import { FormatStudio } from "@/components/studio/FormatStudio";
import { GenerativeFormatStudio } from "@/components/studio/generative";
import { CONTENT_FORMATS, findContentFormat } from "@/lib/content/formats";
import { CUSTOM_ROUTE_ID, studioFormatOf } from "@/lib/studio/studio-formats";

interface PageProps {
  params: Promise<{ format: string }>;
}

/**
 * `/content/<formato>` · PRD:240-262 — 22 rutas, una por formato.
 *
 * **Por qué una ruta dinámica y no 22 archivos.** El PRD enumera 22 paths y los
 * 22 existen: `generateStaticParams` los declara uno a uno, así que el build los
 * prerenderiza por separado. Un segmento que no esté en la lista es un **404**.
 *
 * Qué monta cada uno (sprint 7):
 * - los cuatro formatos base (slideshow, wall of text, green screen, video
 *   hook) → el Studio: `Create New` paso a paso y `Remix` (`FormatStudio`);
 * - `custom` → la subida de video propio (`CustomVideoUpload`);
 * - los 17 generativos → el estudio del agente G (`GenerativeFormatStudio`),
 *   que decide qué hacer con un formato que todavía no soporta.
 */
export function generateStaticParams(): { format: string }[] {
  return CONTENT_FORMATS.map((format) => ({ format: format.id }));
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { format } = await params;
  const found = findContentFormat(format);
  return {
    title: found === undefined ? "Content · FastGram" : `${found.label} · FastGram`,
  };
}

export default async function ContentFormatPage({ params }: PageProps) {
  const { format } = await params;
  const found = findContentFormat(format);
  if (found === undefined) notFound();

  if (found.id === CUSTOM_ROUTE_ID) {
    return (
      <div className="fgw-page">
        <PageHeader title={found.label} description={found.description} />
        <CustomVideoUpload />
      </div>
    );
  }

  const studio = studioFormatOf(found.id);
  if (studio !== null) {
    return (
      <div className="fgw-page">
        <PageHeader title={found.label} description={found.description} />
        <FormatStudio format={studio} />
      </div>
    );
  }

  return (
    <div className="fgw-page">
      <PageHeader title={found.label} description={found.description} />
      <GenerativeFormatStudio formatId={found.id} />
    </div>
  );
}
