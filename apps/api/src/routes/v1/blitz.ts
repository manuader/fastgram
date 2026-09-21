/**
 * Blitz — `GET /blitz/preferences`.
 *
 * Fuente: PRD §9.3, FR-055, DATA-006.
 *
 * ## Qué falta acá y por qué
 *
 * `POST /blitz` y `PATCH /blitz/preferences` **no están implementados**. Los dos
 * escriben, y `@fastgram/db` no expone métodos de escritura: los 28 repositorios dan
 * `findById`, `list`, `count` y `softDelete`. Escribir la query a mano desde la ruta
 * significaría armar el `WHERE` de tenant acá, que es exactamente lo que la
 * arquitectura evita — un olvido no falla, devuelve datos de otro workspace.
 *
 * Lo que hace falta en `packages/db` para cerrarlos está en el reporte, ruta por ruta.
 */
import { blitzPreferencesRepository } from "@fastgram/db";

import { toBlitzPreferences } from "../../support/serializers.js";
import { data } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

/**
 * Defaults sintetizados de `BlitzPreferences` (DATA-006: *"Sintetiza defaults si no
 * existe fila"*).
 *
 * **Sólo dos de estos números están en el PRD**: `influencerChance` 50 (PRD:1273) y
 * `smartTextPositioning` true (AI-014). Los demás son asunciones documentadas:
 *  - los cuatro pesos de formato van 25/25/25/25 porque la única restricción del PRD es
 *    que sumen 100, y el reparto par es la única elección que no privilegia un formato
 *    sin que nadie lo haya pedido;
 *  - los tres porcentajes arrancan en 0 porque son opt-in: remixar contenido ajeno o
 *    mencionar el negocio son decisiones del usuario, no defaults razonables.
 *
 * Están fijadas por un test para que cambiarlas sea deliberado y no un descuido.
 */
export const DEFAULT_BLITZ_PREFERENCES = {
  slideshowWeight: 25,
  wallOfTextWeight: 25,
  greenScreenWeight: 25,
  videoHookWeight: 25,
  remixPercentage: 0,
  ownMediaPercentage: 0,
  mentionBusinessPercentage: 0,
  influencerChance: 50,
  smartTextPositioning: true,
  genderFilter: null,
} as const;

/** FR-055 (PRD:1288) — `settingsApplication` es sólo de respuesta y constante. */
export const SETTINGS_APPLICATION = {
  mode: "future_generations",
  targetQueuedItems: 5,
} as const;

export function registerBlitzRoutes(app: ZodApp): void {
  // ── GET /blitz/preferences ──
  app.get("/blitz/preferences", async (request) => {
    const companyId = request.auth.companyId;

    // `blitzPreferences` es 1:1 con la company: su PK **es** el `companyId`, y el
    // repositorio lo refleja. Por eso el id que se le pasa es el propio companyId.
    const row = await request.tx((tx) =>
      blitzPreferencesRepository.findById(tx, { companyId }, companyId),
    );

    // DATA-006: sin fila, se sintetizan defaults. **No se crea la fila**: leer no
    // escribe, y materializarla acá fijaría todos los campos por un GET.
    if (row === null) {
      return data({
        ...DEFAULT_BLITZ_PREFERENCES,
        angleWeights: {},
        textStyleWeights: {},
        settingsApplication: SETTINGS_APPLICATION,
      });
    }
    return data(toBlitzPreferences(row));
  });
}
