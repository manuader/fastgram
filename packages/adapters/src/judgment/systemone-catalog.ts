/**
 * Catálogo y prueba de conexión de los motores SystemOne — D-18 (sprint 9, O).
 *
 * Mismo lugar que los catálogos de imagen y video (`genai/`): los ids de
 * modelo viven en el adaptador que sabe hablarles, no en `core` (D-14: ningún
 * id de modelo fijo en el código de producto).
 *
 * ## De dónde sale cada id
 *
 * - Laya: los tres checkpoints que `laya.serve` reconoce en el campo `model`
 *   (`_KNOWN_MODELS = {"english", "multilingual", "typed-decisions"}` en
 *   `laya/serve.py`, 0.3.21). Cualquier otro valor —y `auto` es el que usamos
 *   para eso— hace que el router elija por idioma/escritura. `auto` no viaja:
 *   el adaptador omite `model` (`LAYA_AUTO_MODEL`).
 * - Jev: `jev-latest` (docs.typesafe.ai/api.md, 2026-09-28). Es un alias
 *   móvil —lo que `DATA-033` no quiere—, pero es el único id que la doc
 *   publica; el modelo que respondió de verdad queda en la respuesta cruda.
 */
import { PortError, type SystemOneProvider } from "@fastgram/ports";

import {
  JEV_MAX_CHOICE_OPTIONS,
  LAYA_AUTO_MODEL,
  LAYA_MAX_CHOICE_OPTIONS,
  LAYA_SOFT_CHOICE_OPTIONS,
  SystemOneJudgmentAdapter,
  type SystemOneFetch,
  type SystemOneJudgmentOptions,
} from "./systemone-judgment.js";

export interface SystemOneModel {
  readonly id: string;
  /** Para la UI. En inglés: va directo a la pantalla. */
  readonly label: string;
}

export const SYSTEMONE_MODELS: Readonly<
  Record<SystemOneProvider, readonly SystemOneModel[]>
> = {
  laya: [
    { id: LAYA_AUTO_MODEL, label: "Automatic (English or multilingual, by language)" },
    { id: "english", label: "English checkpoint" },
    { id: "multilingual", label: "Multilingual checkpoint (100+ languages)" },
    { id: "typed-decisions", label: "Typed-decisions checkpoint" },
  ],
  typesafe: [{ id: "jev-latest", label: "Jev (latest)" }],
};

/** El id por defecto al elegir el proveedor en la pantalla: el primero. */
export function defaultSystemOneModel(provider: SystemOneProvider): string {
  return SYSTEMONE_MODELS[provider][0]?.id ?? "";
}

/** `DATA-033.adapter` de cada proveedor (enum `judgment_adapter`). */
export function systemOneAdapterName(provider: SystemOneProvider): "laya" | "jev" {
  return provider === "laya" ? "laya" : "jev";
}

/**
 * Las opciones del adaptador para un proveedor: nombre, topes de opciones y el
 * aviso de Laya. Lo único que cambia entre Laya y Jev además de base y key.
 */
export function systemOneOptions(config: {
  readonly provider: SystemOneProvider;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}): Pick<
  SystemOneJudgmentOptions,
  "adapter" | "baseUrl" | "apiKey" | "model" | "maxChoiceOptions" | "softChoiceOptions"
> {
  const laya = config.provider === "laya";
  return {
    adapter: systemOneAdapterName(config.provider),
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
    maxChoiceOptions: laya ? LAYA_MAX_CHOICE_OPTIONS : JEV_MAX_CHOICE_OPTIONS,
    softChoiceOptions: laya ? LAYA_SOFT_CHOICE_OPTIONS : null,
  };
}

export interface SystemOneProbeResult {
  /** Lo que respondió (Laya: `laya-rl-agent/<checkpoint>`). */
  readonly model: string;
  readonly latencyMs: number;
}

/**
 * «Probar conexión»: en Laya, `GET /health` (sin costo, dice si el server está
 * arriba y en qué dispositivo) y después una pregunta trivial; en Jev, sólo la
 * pregunta (no hay health documentado). La pregunta confirma lo que importa:
 * que la base habla SystemOne y que la key sirve.
 *
 * Errores: los `PortError` del adaptador (`unauthorized`, `timeout`,
 * `provider_unavailable`, `not_found`, …).
 */
export async function probeSystemOne(config: {
  readonly provider: SystemOneProvider;
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
  readonly timeoutMs: number;
  readonly fetch?: SystemOneFetch;
}): Promise<SystemOneProbeResult> {
  const doFetch = config.fetch ?? ((input, init) => fetch(input, init));
  const source = `Judgment/${systemOneAdapterName(config.provider)}`;
  const started = Date.now();
  if (config.provider === "laya") {
    const base = config.baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/, "");
    let ok = false;
    try {
      const res = await doFetch(`${base}/health`, {
        method: "GET",
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      const body = (await res.json().catch(() => null)) as { status?: unknown } | null;
      ok = res.ok && body !== null && body.status === "ok";
    } catch (cause) {
      throw new PortError(
        "provider_unavailable",
        "Laya is not answering. Is laya-serve running?",
        { source, cause },
      );
    }
    if (!ok) {
      throw new PortError(
        "provider_contract_violation",
        "That URL does not answer like laya-serve",
        { source },
      );
    }
  }
  let model = config.model;
  const adapter = new SystemOneJudgmentAdapter({
    ...systemOneOptions(config),
    ...(config.fetch === undefined ? {} : { fetch: config.fetch }),
    onRawResponse: (raw) => {
      model = raw.model;
    },
  });
  const remaining = Math.max(1_000, config.timeoutMs - (Date.now() - started));
  await adapter.noul({
    // Cualquier `DP` sirve: es una prueba y no se persiste.
    decisionPoint: "DP-005",
    state: { text: "The sky is blue on a clear day." },
    question: {
      id: "probe",
      kind: "noul",
      instructions: "Does the text describe the weather?",
      criteria: {
        true: "The text talks about the sky or the weather.",
        false: "The text is about something else.",
      },
    },
    timeoutMs: remaining,
  });
  return { model, latencyMs: Date.now() - started };
}
