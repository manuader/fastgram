/**
 * Superficie v1 — PRD §9.3.
 *
 * Todo lo que se registra acá vive bajo `/api/v1` y **detrás del hook de scope**: el
 * plugin que monta esto agrega el hook antes de llamar a esta función, así que no hay
 * forma de añadir una ruta v1 sin `companyId` resuelto. Esa es la garantía que hace
 * cierta la promesa de §9.2, y depende del orden de registro, no de la disciplina de
 * quien agrega la próxima ruta.
 */
import type { ZodApp } from "../../server/types.js";

import { registerAiStudioRoutes } from "./ai-studio.js";
import { registerAnalyticsRoutes } from "./analytics.js";
import { registerAutopilotRoutes } from "./autopilot.js";
import { defaultGenAiRouteDeps, registerGenAiRoutes } from "./genai.js";
import { registerAngleRoutes } from "./angles.js";
import { registerBlitzRoutes } from "./blitz.js";
import { registerBrandRoutes } from "./brand.js";
import { registerCalendarRoutes } from "./calendar.js";
import { registerCatalogRoutes } from "./catalog.js";
import { registerConnectionRoutes } from "./connections.js";
import { registerContentRoutes } from "./content.js";
import { registerInfluencerRoutes } from "./influencers.js";
import { registerMediaRoutes } from "./media.js";
import { registerModelRoutes } from "./models.js";
import { registerOnboardingRoutes } from "./onboarding.js";
import { registerPostRoutes } from "./posts.js";
import { registerStrategyRoutes } from "./strategy.js";
import { registerWorkspaceRoutes } from "./workspaces.js";

export async function registerV1Routes(app: ZodApp): Promise<void> {
  registerBlitzRoutes(app);
  registerAngleRoutes(app);
  registerContentRoutes(app);
  registerMediaRoutes(app);
  registerInfluencerRoutes(app);
  registerCatalogRoutes(app);
  registerPostRoutes(app);
  // EXT-001. Estaba entero en `packages/core` y en el OpenAPI, y no tenía una
  // sola ruta: dominio inalcanzable y un contrato que publicaba cinco paths
  // inexistentes. `test/openapi-routes.test.ts` impide que vuelva a pasar.
  registerBrandRoutes(app);
  // `FR-010`. Mismo diagnóstico que `/brand`: la máquina de cinco pasos estaba
  // entera en `packages/core` y no tenía una sola ruta. Y arrastraba algo
  // concreto — el PRD dice tres veces (759, 1890, 2006) que al cerrar el alta
  // hay que arrancar el relleno de la discovery queue, y ése era el disparador
  // que faltaba.
  registerOnboardingRoutes(app);
  // `PU-BRAND-001` / `PU-RUN-002`: marcas del dueño y `GET /mode`.
  registerWorkspaceRoutes(app);
  // `PU-MODEL-001`/`002`: registro de modelos por tarea (D-14).
  registerModelRoutes(app);
  // `PU-MODEL-005` / `PU-LATER-005`: tope mensual y AI Studio (Higgsfield, fal).
  const genai = defaultGenAiRouteDeps();
  registerGenAiRoutes(app, genai);
  registerAiStudioRoutes(app, genai);
  // `PU-BRAND-002` / `PU-CAL-001` / `PU-CAL-002`: estrategia, auto-slot y calendario.
  registerStrategyRoutes(app);
  registerCalendarRoutes(app);
  // `PU-PUB-001`/`002`, `P3-OAUTH-002`: OAuth por marca y credenciales de las apps.
  registerConnectionRoutes(app);
  // `P3-ANALYT-001/002`, `PU-AUTO-004`: resumen, auto-tune del mix y sync a pedido.
  registerAnalyticsRoutes(app);
  // `PU-AUTO-002`/`003`: resumen diario y política del piloto automático.
  registerAutopilotRoutes(app);
  await Promise.resolve();
}
