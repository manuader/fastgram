import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";
import { PageHeader } from "@/components/shell/PageHeader";
import { CustomVideoUpload } from "@/components/studio/CustomVideoUpload";
import { CONTENT_FORMATS, findContentFormat } from "@/lib/content/formats";
import { CUSTOM_FORMAT_ID } from "@/lib/studio/custom-video";

interface PageProps {
  params: Promise<{ format: string }>;
}

/**
 * `/content/<formato>` · PRD:240-262 — 22 rutas, una por formato.
 *
 * **Por qué una ruta dinámica y no 22 archivos.** El PRD enumera 22 paths y los
 * 22 existen: `generateStaticParams` los declara uno a uno, así que el build los
 * prerenderiza por separado y salen los 22 en la salida de `next build`. Lo que
 * se evita es copiar 22 veces el mismo archivo, que es 22 veces la oportunidad
 * de que uno se quede atrás cuando el editor cambie.
 *
 * Un segmento que no esté en la lista es un **404**, no una página vacía:
 * `/content/no-existe` no es un formato del producto.
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

  /**
   * `custom` es el único de los 22 que tiene pantalla · `P2-STUDIO-009`,
   * `F-083`. No es un privilegio: es el único cuyo backend existe entero
   * (`/content/custom/video/upload-url` + `/content/custom/video`). Los otros
   * 21 necesitan el wizard de `P2-STUDIO-002`, que no está, y un placeholder
   * honesto es mejor que un formulario que no puede generar nada.
   */
  if (found.id === CUSTOM_FORMAT_ID) {
    return (
      <div className="fgw-page">
        <PageHeader title={found.label} description={found.description} />
        <CustomVideoUpload />
      </div>
    );
  }

  return (
    <RoutePlaceholder
      screen={found.label}
      spec="PRD §3.1 · F-070/F-084 · FR-070"
      task="P2-STUDIO-001"
    >
      <p>{found.description}</p>
    </RoutePlaceholder>
  );
}
