import { Card } from "@fastgram/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/shell/PageHeader";
import { ChevronRightIcon } from "@/icons";
import { CONTENT_FORMATS } from "@/lib/content/formats";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";

export const metadata: Metadata = { title: "Content · FastGram" };

/**
 * Hub `/content` · F-070/F-084 (PRD:528-553), §3.3.
 *
 * El PRD describe la tarjeta de cada formato como "label + description + poster
 * + video de ejemplo". Aquí están el label y la description —literales— y no
 * están el poster ni el video: son assets que el repo no tiene y que nadie ha
 * decidido de dónde salen. Un `<video>` apuntando a nada sería peor que su
 * ausencia.
 *
 * Que sea un `<Link>` y no un `<div onClick>` no es detalle: la tarjeta entera
 * es navegable con teclado y se puede abrir en pestaña nueva.
 */
export default function ContentHubPage() {
  return (
    <div className="fgw-page">
      <PageHeader title={tw("nav.content")} />
      <ul className="fgw-format-grid">
        {CONTENT_FORMATS.map((format) => (
          <li key={format.id}>
            <Link
              href={`${ROUTES.content}/${format.id}`}
              className="fgw-format-card fg-focusable"
            >
              <Card interactive padding="md" className="fgw-format-card__surface">
                <span className="fgw-format-card__label">{format.label}</span>
                <span className="fgw-format-card__description">{format.description}</span>
                <span className="fgw-format-card__chevron" aria-hidden="true">
                  <ChevronRightIcon size={16} />
                </span>
              </Card>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
