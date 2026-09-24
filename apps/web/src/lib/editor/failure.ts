/**
 * Por qué falló la última edición o el Regenerate · FR-051 (PRD:1204).
 *
 * `lastEdit` es un objeto opaco en el contrato (`z.record`): el worker escribe
 * `{ at, outcome: "failed", kind, failureReason }` al revertir un rebuild
 * (`apps/worker/src/content/build-handler.ts`). `failureReason` es un código
 * estable, nunca el mensaje del proveedor. Acá se lee con cuidado —cualquier
 * campo puede faltar o venir con otro tipo— y se traduce a copy.
 */
import type { CopyKey } from "../i18n/t";

export interface EditFailure {
  /** `regenerate` si lo que falló fue "Regenerate Text"; si no, una edición. */
  readonly kind: "edit" | "regenerate";
  /** El código de `failureReason`, o `null` si no vino. */
  readonly reason: string | null;
}

/**
 * Los códigos que el worker escribe hoy en `lastEdit.failureReason` para un
 * rebuild o un regenerate. Uno que no esté acá (`invalid_build_payload`, uno
 * nuevo) se muestra sólo con el titular: sin inventar un motivo.
 */
const FAILURE_COPY: Readonly<Record<string, CopyKey>> = {
  llm_not_configured: "editor.failure.llm_not_configured",
  llm_failed: "editor.failure.llm_failed",
  copy_rejected: "editor.failure.copy_rejected",
  edit_not_renderable: "editor.failure.edit_not_renderable",
};

/** El `lastEdit` fallido, o `null` si la última edición salió (o no hubo). */
export function editFailureOf(
  lastEdit: Readonly<Record<string, unknown>> | undefined,
): EditFailure | null {
  if (lastEdit?.["outcome"] !== "failed") return null;
  const reason = lastEdit["failureReason"];
  return {
    kind: lastEdit["kind"] === "regenerate" ? "regenerate" : "edit",
    reason: typeof reason === "string" && reason !== "" ? reason : null,
  };
}

/** El copy del motivo, o `null` si el código no es uno conocido. */
export function failureReasonKey(reason: string | null): CopyKey | null {
  if (reason === null || !Object.hasOwn(FAILURE_COPY, reason)) return null;
  return FAILURE_COPY[reason] ?? null;
}

/** El motivo que se arregla en Settings → Models. */
export function needsModelSetup(reason: string | null): boolean {
  return reason === "llm_not_configured";
}
