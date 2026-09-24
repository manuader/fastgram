/**
 * La copy de una sugerencia sobre el puerto `Llm` — `AI-002`, ADR-009.
 *
 * Mismo reparto que `brand/synthesizer.ts`: `core` arma el pedido
 * (`buildSuggestionCopyRequest`, que decide que el texto del workspace viaja
 * **sólo** en `untrusted`) y lee la respuesta (`parseSuggestionCopy`); acá sólo
 * se habla con el puerto.
 *
 * **No fija modelo, temperatura ni tope de tokens.** ADR-009 prohíbe fijar el
 * modelo (sale de `LLM_MODEL` por el adaptador) y el PRD no da ninguno de los
 * otros dos números: se usa el default del gateway.
 *
 * Un `PortError` del adaptador (`rate_limited`, `timeout`, …) **se propaga**:
 * quien decide si reintentar es el handler, que sabe si el job tiene intentos.
 */
import { randomBytes } from "node:crypto";

import {
  buildSuggestionCopyRequest,
  parseSuggestionCopy,
  type SuggestionCopy,
  type SuggestionCopyInput,
} from "@fastgram/core";
import type { Llm } from "@fastgram/ports";

export type CopyOutcome =
  | { readonly ok: true; readonly copy: SuggestionCopy; readonly model: string }
  /** El modelo contestó algo que no sirve. Reintentar no lo arregla. */
  | { readonly ok: false; readonly reason: string; readonly model: string };

export interface SuggestionCopywriter {
  write(input: SuggestionCopyInput): Promise<CopyOutcome>;
}

export interface LlmCopywriterDeps {
  readonly llm: Llm;
  /**
   * La marca del contenedor de `containUntrusted`: impredecible para quien
   * escribió el perfil o el ángulo. Default 16 bytes aleatorios por llamada;
   * se inyecta sólo en tests.
   */
  readonly fence?: () => string;
}

const randomFence = (): string => `data-${randomBytes(16).toString("hex")}`;

export function createLlmCopywriter(deps: LlmCopywriterDeps): SuggestionCopywriter {
  const fence = deps.fence ?? randomFence;
  return {
    async write(input: SuggestionCopyInput): Promise<CopyOutcome> {
      const request = buildSuggestionCopyRequest(input, fence());
      const completion = await deps.llm.completeJson({
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
      const parsed = parseSuggestionCopy(completion.value, {
        maxTexts: input.maxTexts,
        language: input.language,
      });
      if (!parsed.ok)
        return { ok: false, reason: parsed.reason, model: completion.model };
      return { ok: true, copy: parsed.copy, model: completion.model };
    },
  };
}
