"use client";

import { Button, buttonVariants } from "@fastgram/ui";
import Link from "next/link";
import { useId } from "react";
import { OwnPostsImportButton } from "@/components/library/OwnPostsImportButton";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import {
  offerBody,
  useDismissPostAnalysisOffer,
  usePostAnalysisOffer,
} from "./post-analysis-offer";

/**
 * La oferta post-análisis · `P1-ONB-007`, `D-04`, `FR-011.5.1`.
 *
 * **Después** del análisis, nunca antes: la API sólo dice `show` cuando una
 * fuente terminó `ready`/`partial` (`GET /brand/post-analysis-offer`). Ofrece
 * dos cosas, como el copy del PRD:
 *
 * - conectar las cuentas de publicación de la marca (Settings → Connections);
 * - importar sus posts al Media Bank: el diálogo de `OwnPostsImportButton`,
 *   que es **opt-in** — su casilla arranca desmarcada y sin marcarla no se
 *   importa nada.
 *
 * Descartable (`Not now`), por marca y en el servidor. Sin datos (cargando o
 * error) no dibuja nada: es una oferta, no un estado que el usuario necesite.
 */
export function PostAnalysisOfferCard() {
  const headingId = useId();
  const offer = usePostAnalysisOffer();
  const dismiss = useDismissPostAnalysisOffer();

  if (offer.data === undefined || !offer.data.show) return null;

  return (
    <aside
      className="fgw-brand__offer flex flex-col gap-2 rounded-lg border border-border p-4"
      aria-labelledby={headingId}
      data-testid="post-analysis-offer"
    >
      <h2 id={headingId} className="fgw-brand-section__title m-0">
        {tw("brand.offer.title")}
      </h2>
      <p className="m-0">{offerBody(offer.data.source)}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Link
          href={ROUTES.settingsConnections}
          className={buttonVariants({ variant: "primary", size: "sm" })}
        >
          {tw("brand.offer.connect")}
        </Link>
        <OwnPostsImportButton />
        <Button
          variant="ghost"
          size="sm"
          loading={dismiss.isPending}
          onClick={() => {
            dismiss.mutate();
          }}
        >
          {tw("brand.offer.dismiss")}
        </Button>
      </div>
      <p className="m-0 text-xs text-text-muted">{tw("brand.offer.importHint")}</p>
      {dismiss.isError && (
        <p role="alert" className="m-0 text-sm text-danger">
          {tw("brand.offer.dismissFailed")}
        </p>
      )}
    </aside>
  );
}
