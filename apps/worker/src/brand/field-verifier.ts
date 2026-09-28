/**
 * `JV-4` en el worker — `DP-004`, `P2-JV-004`, `P1-BRAND-016`.
 *
 * La lógica (preguntas, estado, mapeo a `high/medium/low`) es de `core`
 * (`packages/core/src/brand/field-verifier.ts`). Acá sólo se decide **con qué
 * juicio** se pregunta y qué pasa cuando no contesta.
 *
 * ## De dónde sale el juicio
 *
 * El juicio de la tarea `judgment.brand` del registro de modelos (LLM o, desde
 * el sprint 9, un SystemOne: `judgment/judgment-source.ts`)
 * (`P1-JUDGE-004`): sin entrada propia usa `judgment`, que hereda `text`. Se
 * resuelve en cada análisis. Cada lote deja su fila en `judgment_records`
 * (`RecordingJudgment`, `DATA-033`) con el campo como sujeto.
 *
 * ## Fallback conservador
 *
 * Sin modelo, con timeout o error del proveedor, o con una respuesta fuera de
 * forma, el campo **no se toca**: sigue con la confianza del sintetizador, que
 * `materializeField` recorta a `low`. Un verificador caído nunca sube una
 * confianza, y nunca tumba el análisis: la síntesis ya se pagó.
 */
import {
  FIELD_VERIFIER_QUESTIONS,
  applyVerification,
  buildFieldVerificationState,
  isVerifiable,
  parseFieldVerifierAnswers,
  type DerivedField,
} from "@fastgram/core";
import type { Database } from "@fastgram/db";
import type { Judgment } from "@fastgram/ports";

import type { BuildLogger } from "../content/build-handler.js";
import { judgmentSourceFor } from "../judgment/judgment-source.js";
import type { LlmSource } from "../llm/registry-llm.js";

/** Presupuesto por campo. No es un número del PRD: JV-4 es asíncrono (no hay humano esperando). */
export const FIELD_VERIFIER_TIMEOUT_MS = 30_000;

export interface FieldVerifier {
  /**
   * Los campos con la confianza medida por `JV-4` donde se pudo. Nunca lanza:
   * lo que no se pudo verificar vuelve igual que entró.
   */
  verify(
    fields: readonly DerivedField[],
    subject: { readonly companyId: string; readonly sourceId: string },
  ): Promise<readonly DerivedField[]>;
}

/** El juicio para un campo, o `null` si no hay modelo de juicio. */
export type FieldJudgmentProvider = (subject: {
  readonly companyId: string;
  readonly subjectId: string;
}) => Promise<Judgment | null>;

export function createFieldVerifier(deps: {
  readonly judgment: FieldJudgmentProvider;
  readonly logger: BuildLogger;
  readonly timeoutMs?: number;
}): FieldVerifier {
  const timeoutMs = deps.timeoutMs ?? FIELD_VERIFIER_TIMEOUT_MS;
  return {
    async verify(fields, subject) {
      const out: DerivedField[] = [];
      let verified = 0;
      let skipped = 0;
      // Secuencial a propósito: son ocho campos como mucho, y un modelo local
      // (Ollama) atiende de a uno; en paralelo sólo se encolan en su lado.
      for (const field of fields) {
        if (!isVerifiable(field)) {
          out.push(field);
          continue;
        }
        const judgment = await deps.judgment({
          companyId: subject.companyId,
          subjectId: subject.sourceId,
        });
        if (judgment === null) {
          out.push(field);
          skipped += 1;
          continue;
        }
        try {
          const { answers } = await judgment.ask({
            decisionPoint: "DP-004",
            state: buildFieldVerificationState(field),
            questions: FIELD_VERIFIER_QUESTIONS,
            timeoutMs,
          });
          const parsed = parseFieldVerifierAnswers(answers);
          if (parsed === null) {
            out.push(field);
            skipped += 1;
            continue;
          }
          out.push(applyVerification(field, parsed));
          verified += 1;
        } catch (error: unknown) {
          deps.logger.warn(
            {
              companyId: subject.companyId,
              sourceId: subject.sourceId,
              field: field.field,
              reason: error instanceof Error ? error.message : String(error),
            },
            "JV-4 no pudo verificar el campo: queda con la confianza del sintetizador (low)",
          );
          out.push(field);
          skipped += 1;
        }
      }
      if (verified + skipped > 0) {
        deps.logger.info(
          { companyId: subject.companyId, sourceId: subject.sourceId, verified, skipped },
          "JV-4: campos de marca verificados",
        );
      }
      return out;
    },
  };
}

/** El proveedor real: `judgment.brand` del registro, grabando en `judgment_records`. */
export function createRegistryFieldJudgment(deps: {
  readonly llmSource: LlmSource;
  readonly db: Database;
  readonly appRole: string | undefined;
  readonly logger: BuildLogger;
}): FieldJudgmentProvider {
  // Sprint 9 (O, D-18): LLM o SystemOne según el registro (`judgment-source.ts`).
  const source = judgmentSourceFor(deps);
  return async (subject) =>
    (
      await source.resolve("judgment.brand", {
        companyId: subject.companyId,
        subjectType: "brand_source",
        subjectId: subject.subjectId,
      })
    )?.judgment ?? null;
}
