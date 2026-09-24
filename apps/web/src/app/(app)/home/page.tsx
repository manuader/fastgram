import type { Metadata } from "next";
import { TodayScreen } from "@/components/today/TodayScreen";

export const metadata: Metadata = { title: "Today · FastGram" };

/**
 * `/home` es "Today" · `PU-UI-002` (`docs/PLAN-USO-PERSONAL.md` §7).
 *
 * Reemplaza al dashboard de FR-030 (`P1-UI-009`/`P1-UI-010`: KPIs, Tasks, Views
 * History, FAQ). Los componentes de ese dashboard siguen en `components/home` y
 * `lib/home`, sin montar: la FAQ es copy literal del PRD que puede reusarse en
 * `/guide`, y borrarla es una decisión del dueño, no de esta tarea.
 */
export default function HomePage() {
  return <TodayScreen />;
}
