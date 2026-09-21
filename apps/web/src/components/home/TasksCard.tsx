import { Badge, Card, CardHeader, CardTitle } from "@fastgram/ui";
import { ChevronRightIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";

/**
 * Tarjeta **Tasks** del Home · FR-030 (PRD:1035).
 *
 * El PRD fija la forma y el copy: contador `Completed N`, filas con badge
 * `Suggested`, título (`Reply to leads`), progreso (`0/5`) y chevron de
 * expansión. Lo que **no** existe es el endpoint: "las tareas se generan a
 * partir del estado del workspace" y eso no está en la API v1.
 *
 * Se dibuja la fila que el PRD nombra —`Reply to leads`, `0/5`— con los números
 * a cero y un aviso encima. La alternativa era no dibujar nada, y entonces
 * quien construya esto no sabría qué forma tiene que tener.
 */
export function TasksCard() {
  return (
    <Card className="fgw-card">
      <CardHeader className="fgw-card__head">
        <CardTitle as="h2">{tw("home.tasks.title")}</CardTitle>
        <span className="fgw-card__meta">{tw("home.tasks.completed", { count: 0 })}</span>
      </CardHeader>

      <p className="fgw-card__notice" role="note">
        {tw("placeholder.noEndpoint.description")}
      </p>

      <ul className="fgw-tasks">
        <li className="fgw-tasks__row">
          <Badge tone="info">{tw("home.tasks.suggested")}</Badge>
          <span className="fgw-tasks__title">{tw("home.tasks.replyToLeads")}</span>
          <span className="fgw-tasks__progress">
            {tw("home.tasks.progress", { done: 0, total: 5 })}
          </span>
          <span className="fgw-tasks__chevron" aria-hidden="true">
            <ChevronRightIcon size={16} />
          </span>
        </li>
      </ul>
    </Card>
  );
}
