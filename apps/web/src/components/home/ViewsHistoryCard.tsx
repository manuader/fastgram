import { Button, Card, CardHeader, CardTitle, Select } from "@fastgram/ui";
import { BarChartIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";

/**
 * Tarjeta **Views History** del Home · FR-030 (PRD:1036).
 *
 * El PRD fija tres elementos: la línea temporal por día, el botón
 * `Enable website analytics` y el selector de rango `Monthly`.
 *
 * Ni la serie ni la acción tienen endpoint en la API v1 (§9.3). Se dibuja el
 * marco con los controles **deshabilitados** en vez de habilitados sin efecto:
 * un botón que se pulsa y no pasa nada es peor que uno que dice que todavía no.
 *
 * El selector trae una sola opción porque el PRD sólo nombra una (`Monthly`).
 * Inventar `Weekly` y `Daily` sería inventar producto.
 */
export function ViewsHistoryCard() {
  return (
    <Card className="fgw-card">
      <CardHeader className="fgw-card__head">
        <CardTitle as="h2">{tw("home.viewsHistory.title")}</CardTitle>
        <Select
          aria-label={tw("home.viewsHistory.monthly")}
          disabled
          defaultValue="monthly"
          options={[{ value: "monthly", label: tw("home.viewsHistory.monthly") }]}
          selectSize="sm"
        />
      </CardHeader>

      <div
        className="fgw-chart-placeholder"
        role="img"
        aria-label={tw("home.viewsHistory.title")}
      >
        <BarChartIcon size={28} />
      </div>

      <p className="fgw-card__notice" role="note">
        {tw("placeholder.noEndpoint.description")}
      </p>

      <Button variant="secondary" disabled>
        {tw("home.viewsHistory.enableAnalytics")}
      </Button>
    </Card>
  );
}
