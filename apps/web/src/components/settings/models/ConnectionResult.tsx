"use client";

import type { ModelConnectionTest, ModelProbeError } from "@fastgram/contracts";
import { MODELS_COPY, PROBE_ERROR_COPY } from "@/lib/models/copy";

function errorText(error: ModelProbeError): string {
  return PROBE_ERROR_COPY[error.code];
}

export interface ConnectionResultProps {
  readonly result: ModelConnectionTest;
}

/**
 * El resultado de «Test connection», en una línea y con el porqué.
 *
 * Primero lo que más le sirve al usuario: si la llamada al modelo falló, eso;
 * si no se pidió modelo, cuántos lista el proveedor. Los mensajes salen del
 * código estable, nunca del texto del proveedor (que la API no manda).
 */
export function ConnectionResult({ result }: ConnectionResultProps) {
  const { models, completion } = result;

  let tone: "ok" | "error";
  let text: string;
  if (completion !== null && !completion.ok) {
    tone = "error";
    text = errorText(completion.error);
  } else if (!models.ok && (completion === null || !completion.ok)) {
    tone = "error";
    text = errorText(models.error);
  } else if (completion !== null && completion.ok) {
    tone = "ok";
    text = MODELS_COPY.testOk(completion.model, completion.latencyMs);
  } else if (models.ok && models.models.length === 0) {
    tone = "error";
    text = MODELS_COPY.noModelsListed;
  } else {
    tone = "ok";
    text = MODELS_COPY.listOkOnly(models.ok ? models.models.length : 0);
  }

  return (
    <p
      className={
        tone === "ok"
          ? "m-0 flex items-start gap-2 rounded-md bg-surface-sunken p-3 text-sm text-success"
          : "m-0 flex items-start gap-2 rounded-md bg-surface-sunken p-3 text-sm text-danger"
      }
      data-tone={tone}
    >
      <span aria-hidden="true">{tone === "ok" ? "✓" : "!"}</span>
      <span>{text}</span>
    </p>
  );
}
