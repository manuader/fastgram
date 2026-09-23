/**
 * El handler de `content-rebuild` — PRD §9.5.4, `FR-051`, `AI-004`.
 *
 * *"Reconstruye tras una edición o una regeneración."* Lo encolan
 * `PATCH /content/:id` y `POST /content/:id/regenerate`, en la misma
 * transacción que sube la `revision` y deja la pieza en `BUILDING`.
 *
 * ## Por qué es el mismo motor que `content-build`
 *
 * Porque leer con la fila bloqueada, renderizar fuera de transacción, subir con
 * la revisión en la clave y volver a bloquear para comprobar la `revision` al
 * escribir **son las mismas cuatro cosas**, con las mismas carreras. Copiarlas
 * dejaría dos lugares donde arreglar la próxima trampa de la trampa 24.
 *
 * Lo que difiere es el cierre de un fallo definitivo, y está en el motor
 * (`build-handler.ts`, cabecera) porque `content-build` también lo necesita
 * para los jobs de edición que quedaron en su cola:
 *
 * - **No hay reembolso.** Una edición no consume save (PRD:1186, FLOW-008
 *   PRD:1983); el `saveBucket` de la fila es el del build original, que se
 *   entregó.
 * - **No hay `FAILED`.** *"Si el rebuild falla, la versión anterior sigue
 *   siendo usable y se reporta `lastEdit` fallido"* (PRD:1204): vuelve a
 *   `CREATED` con los `files` de antes.
 *
 * ## Lo que hoy NO puede hacer, y por eso falla con motivo
 *
 * **El render lee sólo `buildPayload`**, y ninguna de las dos ediciones que
 * existen lo modifica: `PATCH` escribe `content_text_boxes` y `regenerate`
 * necesita un modelo de copy que este worker no tiene. Una pieza con cajas de
 * texto se cierra como rebuild fallido (`edit_not_renderable`) **sin llamar al
 * renderer**: renderizar produciría la versión de antes con la edición
 * declarada `applied`, que es exactamente lo que la trampa 30 prohíbe escribir.
 *
 * El camino que sí renderiza —pieza sin cajas, `buildPayload` reescrito— es el
 * que tomaría un swap de media (`F-061`) el día que exista una ruta que
 * reescriba el payload. Hoy ninguna lo hace.
 *
 * ## El renderer
 *
 * Se monta con **el mismo** que `content-build` (`handlers.ts`). Un rebuild con
 * otro motor que el build produciría, ante una edición nula, una pieza que se
 * ve distinta. Hoy ese renderer es `MemoryMediaRenderer`: el camino que
 * renderiza deja un artefacto sintético, igual que el build.
 */

import type { JobHandler } from "@fastgram/ports";

import { createContentRenderHandler, type ContentBuildDeps } from "./build-handler.js";

export function createContentRebuildHandler(deps: ContentBuildDeps): JobHandler<unknown> {
  return createContentRenderHandler(deps, "rebuild");
}
