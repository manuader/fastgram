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

import { registerAngleRoutes } from "./angles.js";
import { registerBlitzRoutes } from "./blitz.js";
import { registerCatalogRoutes } from "./catalog.js";
import { registerContentRoutes } from "./content.js";
import { registerInfluencerRoutes } from "./influencers.js";
import { registerMediaRoutes } from "./media.js";
import { registerPostRoutes } from "./posts.js";

export async function registerV1Routes(app: ZodApp): Promise<void> {
  registerBlitzRoutes(app);
  registerAngleRoutes(app);
  registerContentRoutes(app);
  registerMediaRoutes(app);
  registerInfluencerRoutes(app);
  registerCatalogRoutes(app);
  registerPostRoutes(app);
  await Promise.resolve();
}
