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
 * Con `verifier`, cada campo pasa por `JV-4` antes de volver: la confianza
 * deja de ser siempre `low` (`P2-JV-004`).
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

import type { FieldVerifier } from "./field-verifier.js";

export interface BrandSynthesisOutcome {
  readonly fields: readonly DerivedField[];
  /** Campos que el modelo llenó y se vaciaron. Van al log. */
  readonly rejected: readonly RejectedField[];
  /** Intentos de cerrar el contenedor neutralizados. Va al log. */
  readonly fenceEscapeAttempts: number;
  /** Qué modelo respondió de verdad, para el log. */
  readonly model: string;
}

/**
 * `P1-ONB-005`: avisos de progreso. El handler los usa para escribir la fase
 * real de la fuente; un aviso que falla no aborta la síntesis (lo decide
 * quien lo pasa: el handler traga sus propios errores).
 */
export interface SynthesisProgress {
  /** Se llama justo antes de verificar los campos con `JV-4`, si hay verificador. */
  readonly onVerifying?: () => Promise<void>;
}

export interface BrandSynthesizer {
  synthesize(
    input: SynthesisInput,
    progress?: SynthesisProgress,
  ): Promise<BrandSynthesisOutcome>;
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
   * `JV-4` (`DP-004`): mide la confianza de cada campo contra su extracto.
   * Sin él —o sin `companyId` en el input— todo campo queda en `low`, que es
   * el comportamiento anterior. Ver `./field-verifier.ts`.
   */
  readonly verifier?: FieldVerifier;
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
    async synthesize(
      input: SynthesisInput,
      progress?: SynthesisProgress,
    ): Promise<BrandSynthesisOutcome> {
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
      const verifier =
        deps.verifier === undefined || input.companyId === undefined
          ? null
          : deps.verifier;
      if (verifier !== null) await progress?.onVerifying?.();
      const fields =
        verifier === null || input.companyId === undefined
          ? parsed.fields
          : await verifier.verify(parsed.fields, {
              companyId: input.companyId,
              sourceId: input.sourceId,
            });
      return {
        fields,
        rejected: parsed.rejected,
        fenceEscapeAttempts: request.fenceEscapeAttempts,
        model: completion.model,
      };
    },
  };
}
