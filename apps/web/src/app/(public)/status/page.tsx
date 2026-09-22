import type { Metadata } from "next";
import { ServiceStatus } from "@/components/status/ServiceStatus";
import { tw } from "@/lib/i18n/t";

export const metadata: Metadata = { title: "Status · FastGram" };

/**
 * `/status` · F-255 (PRD:721), §3.1 (PRD:259) — `P1-OBS-004`.
 *
 * Server component fino, como el resto: el `<h1>` y poco más. Lo que habla con
 * el servidor vive en `ServiceStatus`, que es cliente — y acá, además, eso no
 * es sólo la convención del proyecto: esta página es **pública** y sin sesión,
 * así que pedir el estado desde el render del servidor haría que cada visita
 * anónima costara una petición al health check aunque el visitante cerrara la
 * pestaña de inmediato. El route handler con su cache corto queda en medio.
 *
 * El `<main id="main">` lo pone el layout de `(public)`.
 */
export default function Page() {
  return (
    <section className="fgw-status-page">
      <h1 className="fgw-status-page__title">{tw("status.title")}</h1>
      <ServiceStatus />
    </section>
  );
}
