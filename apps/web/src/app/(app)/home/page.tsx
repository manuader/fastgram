import type { Metadata } from "next";
import { FaqSection } from "@/components/home/FaqSection";
import { KpiRow } from "@/components/home/KpiRow";
import { TasksCard } from "@/components/home/TasksCard";
import { ViewsHistoryCard } from "@/components/home/ViewsHistoryCard";
import { PageHeader } from "@/components/shell/PageHeader";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";
import { tw } from "@/lib/i18n/t";

export const metadata: Metadata = { title: "Home · FastGram" };

/**
 * Home / Dashboard · `P1-UI-009` + `P1-UI-010` · FR-030 (PRD:1027-1054).
 *
 * Lo que hay y lo que no, sin adornos:
 *
 * · **KPIs** — reales en cuatro de cinco, calculados sumando `GET /posts`.
 *   `Engaged Leads` no tiene endpoint. Ver `lib/home/kpis.ts`.
 * · **Tasks** y **Views History** — con la forma y el copy del PRD, sin datos:
 *   la API v1 no los tiene.
 * · **FAQ** — completa y literal: 5 categorías, 39 preguntas.
 * · **Trending Content** — el PRD (PRD:1037) lo describe como chips de nicho y
 *   un carrusel 3-up. Es la misma feature que `/inspiration` (FR-040), que está
 *   bloqueada por `P2-TREND-001` (una decisión de derechos, no de ingeniería).
 *   Se deja como marcador en vez de dibujar un carrusel vacío.
 * · **Footer con Discord y "book a call"** (PRD:1039) — Discord ya está en el
 *   sidebar; el "book a call" no tiene URL en el PRD, así que no se inventa.
 */
export default function HomePage() {
  return (
    <div className="fgw-page">
      <PageHeader title={tw("home.title")} />
      <KpiRow />
      <div className="fgw-grid-2">
        <TasksCard />
        <ViewsHistoryCard />
      </div>
      <RoutePlaceholder
        screen={tw("home.trending.title")}
        spec="PRD §3.1 · FR-030 (PRD:1037) · FR-040"
        task="P2-TREND-001"
      />
      <FaqSection />
    </div>
  );
}
