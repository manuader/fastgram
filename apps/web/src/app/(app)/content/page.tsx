import { Card } from "@fastgram/ui";
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/shell/PageHeader";
import { ChevronRightIcon } from "@/icons";
import {
  CONTENT_FORMATS,
  EXCLUDED_FORMAT_IDS,
  type ContentFormat,
} from "@/lib/content/formats";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { CUSTOM_ROUTE_ID, STUDIO_ROUTE_IDS } from "@/lib/studio/studio-formats";

export const metadata: Metadata = { title: "Content · FastGram" };

/** Los que se arman a mano en el Studio, más el video propio. */
const BASE_IDS: readonly string[] = [...STUDIO_ROUTE_IDS, CUSTOM_ROUTE_ID];

/**
 * Hub `/content` · F-070/F-084 (PRD:528-553), §3.3 — Content Studio.
 *
 * Dos grupos (sprint 7): los **formatos base** —los cuatro de Blitz, que se
 * arman paso a paso con media del Media Bank, más `Custom`— y los **AI
 * formats**, generativos, cuyo estudio es del agente G. El orden dentro de
 * cada grupo es el de la tabla del PRD.
 *
 * El PRD describe la tarjeta de cada formato como "label + description + poster
 * + video de ejemplo". Aquí están el label y la description —literales— y no
 * están el poster ni el video: son assets que el repo no tiene.
 */
export default function ContentHubPage() {
  const base = CONTENT_FORMATS.filter((f) => BASE_IDS.includes(f.id));
  const generative = CONTENT_FORMATS.filter(
    (f) => !BASE_IDS.includes(f.id) && !EXCLUDED_FORMAT_IDS.has(f.id),
  );
  return (
    <div className="fgw-page">
      <PageHeader title={tw("nav.content")} description={tw("studio.hub.description")} />
      <section aria-labelledby="studio-base" className="mb-8">
        <h2 id="studio-base" className="mb-3 text-sm font-semibold">
          {tw("studio.hub.base")}
        </h2>
        <FormatGrid formats={base} />
      </section>
      <section aria-labelledby="studio-ai">
        <h2 id="studio-ai" className="mb-1 text-sm font-semibold">
          {tw("studio.hub.ai")}
        </h2>
        <p className="mb-3 text-xs text-text-muted">{tw("studio.hub.aiDescription")}</p>
        <FormatGrid formats={generative} />
      </section>
    </div>
  );
}

/**
 * Que sea un `<Link>` y no un `<div onClick>` no es detalle: la tarjeta entera
 * es navegable con teclado y se puede abrir en pestaña nueva.
 */
function FormatGrid({ formats }: { readonly formats: readonly ContentFormat[] }) {
  return (
    <ul className="fgw-format-grid">
      {formats.map((format) => (
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
  );
}
