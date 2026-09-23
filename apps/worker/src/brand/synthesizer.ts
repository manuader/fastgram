/**
 * La etapa 3 de `AI-016` (síntesis) como dependencia inyectada del handler de
 * `brand-source-analysis`, y su implementación sobre el puerto `Llm`.
 *
 * ## Por qué es un puerto del handler y no una llamada directa
 *
 * §9.14: «un extractor por plataforma detrás de una interfaz común, más un
 * **sintetizador único** que consume cualquier snapshot». El handler no sabe
 * de prompts ni de esquemas: recibe un {@link BrandSynthesizer}. Eso permite
 * testear el handler entero sin red y cambiar el sintetizador (por ejemplo,
 * sumar `JV-4` para la confianza) sin tocar la orquestación.
 *
 * ## Qué hace la implementación sobre `Llm`, y qué no
 *
 * Arma el pedido con `buildBrandSynthesisRequest` de `core` —que es quien
 * decide que el texto de terceros viaja **sólo** en `untrusted`— y lee la
 * respuesta con `parseBrandSynthesis`, que aplica las dos comprobaciones que
 * ningún prompt puede saltarse (extracto textual, valor que no sea una orden).
 *
 * **No fija modelo, temperatura ni tope de tokens.** ADR-009: «no se fijan
 * modelos ni precios». El modelo sale de `LLM_MODEL` a través del adaptador.
 */
import { randomBytes } from "node:crypto";

import {
  buildBrandSynthesisRequest,
  parseBrandSynthesis,
  type DerivedField,
  type RejectedField,
  type SynthesisInput,
} from "@fastgram/core";
import type { Llm } from "@fastgram/ports";

export interface BrandSynthesisOutcome {
  readonly fields: readonly DerivedField[];
  /** Campos que el modelo llenó y se vaciaron. Van al log. */
  readonly rejected: readonly RejectedField[];
  /** Intentos de cerrar el contenedor neutralizados. Va al log. */
  readonly fenceEscapeAttempts: number;
  /** Qué modelo respondió de verdad, para el log. */
  readonly model: string;
}

export interface BrandSynthesizer {
  synthesize(input: SynthesisInput): Promise<BrandSynthesisOutcome>;
}

/**
 * La respuesta del modelo no sirve y reintentar no la arregla: filtro de
 * contenido, salida cortada por longitud, o un JSON fuera del esquema.
 *
 * No es un `PortError` a propósito: `PortError` es «algo de afuera falló» con
 * un código del catálogo, y ninguno de los diez describe «el modelo contestó,
 * pero no algo que podamos usar» sin mentir sobre la causa.
 */
export class SynthesisRejectedError extends Error {
  override readonly name = "SynthesisRejectedError";
  constructor(readonly reason: string) {
    super(`brand synthesis rejected: ${reason}`);
  }
}

export interface LlmBrandSynthesizerDeps {
  readonly llm: Llm;
  /**
   * La marca del contenedor de `containUntrusted`. **Tiene que ser
   * impredecible para quien escribió la bio**: si fuera fija, bastaría con
   * escribirla para cerrar el contenedor. Default: 16 bytes aleatorios por
   * llamada. Se inyecta sólo en tests.
   */
  readonly fence?: () => string;
}

const randomFence = (): string => `data-${randomBytes(16).toString("hex")}`;

export function createLlmBrandSynthesizer(
  deps: LlmBrandSynthesizerDeps,
): BrandSynthesizer {
  const fence = deps.fence ?? randomFence;
  return {
    async synthesize(input: SynthesisInput): Promise<BrandSynthesisOutcome> {
      const request = buildBrandSynthesisRequest(input, fence());
      const completion = await deps.llm.completeJson({
        messages: request.messages,
        untrusted: request.untrusted,
        schema: request.schema,
        schemaName: request.schemaName,
      });
      if (completion.finishReason !== "stop") {
        throw new SynthesisRejectedError(`finishReason=${completion.finishReason}`);
      }
      const parsed = parseBrandSynthesis(completion.value, {
        sourceId: input.sourceId,
        sourceType: input.sourceType,
        corpus: request.corpus,
      });
      if (!parsed.ok) throw new SynthesisRejectedError(parsed.reason);
      return {
        fields: parsed.fields,
        rejected: parsed.rejected,
        fenceEscapeAttempts: request.fenceEscapeAttempts,
        model: completion.model,
      };
    },
  };
}
