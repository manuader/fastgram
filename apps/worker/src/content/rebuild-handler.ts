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
 * ## Cómo llega una edición al video (`PU-EDIT-002`)
 *
 * **El render lee sólo `buildPayload`** y `PATCH` escribe `content_text_boxes`.
 * El motor lee las cajas con la fila bloqueada y, si hay, las aplica sobre el
 * `buildPayload` original (`toEditedRenderJob` → `applyTextBoxesToBuildPayload`
 * de `core`): `position` es el centro de la caja en % del lienzo,
 * `widthPercent` su ancho, `font.size`/`stroke.width` siguen en unidades de
 * editor y los escala el render (decisiones del dueño 2026-09-23/24, FR-051 y
 * FR-070). En éxito la pieza queda `CREATED` con los archivos nuevos y el
 * `lastEdit` aplicado que escribió la API.
 *
 * ## `regenerate` (`AI-004`)
 *
 * Reescribe el copy con el LLM de la tarea `text` **antes** de renderizar
 * (`regenerate.ts`, cabecera de `build-handler.ts`), y guarda las cajas nuevas
 * junto con los archivos. Sin modelo cierra con `llm_not_configured`; con una
 * respuesta inválida, `copy_rejected`; con el proveedor caído, `llm_failed`.
 * Nunca renderiza el copy de antes declarándolo regenerado (trampa 30).
 *
 * Lo que sigue cerrando con `edit_not_renderable`, sin llamar al renderer:
 *
 * - **Cajas que no caben en el payload de `FR-070`**: más de una caja en un
 *   formato de `text` singular, o una caja de un slide que no existe. Ver la
 *   cabecera de `core/content/text-boxes-to-build-payload.ts`.
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
