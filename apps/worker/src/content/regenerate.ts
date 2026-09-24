/**
 * `Regenerate Text` sobre el puerto `Llm` — `AI-004`, `F-059`.
 *
 * Mismo reparto que `discovery/copywriter.ts`: `core` arma el pedido
 * (`buildRegenerateCopyRequest`, que decide que el prompt del usuario y los
 * textos actuales viajan **sólo** en `untrusted`), lee la respuesta
 * (`parseRegeneratedCopy`) y produce las cajas (`applyRegeneratedTexts`); acá
 * sólo se habla con el puerto.
 *
 * **No fija modelo, temperatura ni tope de tokens** (ADR-009): el modelo sale
 * del registro de modelos, tarea `text`, en cada job.
 *
 * Un `PortError` del adaptador **se propaga**: quien decide si reintentar es el
 * motor de `content-rebuild`, que sabe cuántos intentos quedan.
 */
import { randomBytes } from "node:crypto";

import { contentBuildPayloadSchema } from "@fastgram/contracts";
import {
  applyRegeneratedTexts,
  buildRegenerateCopyRequest,
  deriveTextBoxesFromBuildPayload,
  parseRegeneratedCopy,
  type ContentTextBox,
  type RegenerateCopyInput,
} from "@fastgram/core";
import type { Llm } from "@fastgram/ports";

/**
 * El LLM de la tarea `text` **ahora**, o `null` si no hay ninguno configurado.
 * En producción, `llmSource.current("text")` del registro de modelos
 * (`llm/registry-llm.ts`): un modelo nuevo en la pantalla llega al próximo
 * regenerate sin reiniciar el worker.
 */
export type CopyLlmProvider = () => Promise<Llm | null>;

export type RegenerateOutcome =
  | {
      readonly ok: true;
      readonly boxes: readonly ContentTextBox[];
      readonly model: string;
    }
  /** El modelo contestó algo que no sirve. Reintentar no lo arregla. */
  | { readonly ok: false; readonly reason: string; readonly model: string };

const randomFence = (): string => `data-${randomBytes(16).toString("hex")}`;

/**
 * Las cajas sobre las que se regenera: las guardadas si hay (son el estado
 * completo del texto, lo mismo que muestra `GET /content/:id/editable`), si no
 * las derivadas del payload — una pieza de Blitz nace sin cajas guardadas.
 * `[]` si el payload no parsea o no tiene texto.
 */
export function regenerationBoxesOf(
  saved: readonly ContentTextBox[],
  buildPayload: unknown,
): readonly ContentTextBox[] {
  if (saved.length > 0) return saved;
  const parsed = contentBuildPayloadSchema.safeParse(buildPayload);
  return parsed.success ? deriveTextBoxesFromBuildPayload(parsed.data) : [];
}

export async function regenerateTextBoxes(
  llm: Llm,
  input: RegenerateCopyInput,
  fence: () => string = randomFence,
): Promise<RegenerateOutcome> {
  const request = buildRegenerateCopyRequest(input, fence());
  const completion = await llm.completeJson({
    messages: request.messages,
    untrusted: request.untrusted,
    schema: request.schema,
    schemaName: request.schemaName,
  });
  if (completion.finishReason !== "stop") {
    return {
      ok: false,
      reason: `finishReason=${completion.finishReason}`,
      model: completion.model,
    };
  }
  const parsed = parseRegeneratedCopy(completion.value, input.boxes);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, model: completion.model };
  const applied = applyRegeneratedTexts(input.boxes, parsed.texts);
  if (!applied.ok) return { ok: false, reason: applied.reason, model: completion.model };
  return { ok: true, boxes: applied.boxes, model: completion.model };
}
