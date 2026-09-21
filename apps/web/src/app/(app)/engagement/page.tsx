import { redirect } from "next/navigation";
import { ROUTES } from "@/lib/nav/routes";

/**
 * `/engagement` no tiene pantalla propia: el PRD lo describe como "layout con
 * tabs" (PRD:231). Se entra por `Actions`, que es la lista de leads y el único
 * sitio donde hay algo que hacer.
 */
export default function EngagementIndex() {
  redirect(ROUTES.engagementActions);
}
