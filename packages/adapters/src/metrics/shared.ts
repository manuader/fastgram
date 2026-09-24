/**
 * Lo común de los adaptadores de métricas — `PU-AUTO-004`.
 *
 * Reusa el HTTP de los publicadores (`publishers/shared/http.ts`) y la
 * clasificación de errores de la Graph API de Meta (`publishers/meta/`), **sin
 * modificarlos**: acá sólo se traduce su vocabulario de publicación («el post
 * falló con `permissions_missing`») al de lectura (`PortError` `forbidden`).
 *
 * Toda llamada de métricas es `phase: "prepare"`: leer no publica nada, así
 * que un timeout es un transitorio común, nunca una entrega incierta.
 */
import {
  PortError,
  type MetricsRequest,
  type SocialMetricsCapabilities,
} from "@fastgram/ports";

import { classifyGraphError, graphErrorOf } from "../publishers/meta/graph-errors.js";
import {
  call,
  field,
  type HttpResult,
  type PublisherFetch,
} from "../publishers/shared/http.js";

export type MetricsFetch = PublisherFetch;

export const DEFAULT_METRICS_TIMEOUT_MS = 20_000;

/** `bad_request` antes de gastar una llamada: más ids que el lote, o sin token. */
export function assertRequest(
  request: MetricsRequest,
  caps: SocialMetricsCapabilities,
  source: string,
): void {
  if (request.externalPostIds.length > caps.maxBatch) {
    throw new PortError(
      "bad_request",
      `At most ${String(caps.maxBatch)} posts per metrics request.`,
      { source },
    );
  }
  if (request.account.accessToken.length === 0) {
    throw new PortError("unauthorized", "The account has no valid access token.", {
      source,
    });
  }
}

export async function getJson(
  fetchImpl: MetricsFetch,
  url: string,
  headers: Record<string, string>,
  options: { readonly source: string; readonly timeoutMs: number },
): Promise<HttpResult> {
  return call(
    fetchImpl,
    url,
    { method: "GET", headers },
    { source: options.source, phase: "prepare", timeoutMs: options.timeoutMs },
  );
}

/**
 * Un error de la Graph API al leer insights de **un** post.
 *
 * - `unavailable`: código `100` («Invalid parameter»). En insights sale tanto
 *   por un objeto que ya no existe como por una métrica que no aplica a ese
 *   tipo de media, y la guía de errores **no documenta** un subcódigo que los
 *   separe (se buscó el `33` que circula: no está). Así que no se afirma
 *   «borrado»: se dice «sin métricas para este post», que es verdad en los dos
 *   casos. Es éxito parcial: no tira el lote.
 * - Todo lo demás lanza: sesión caída (`unauthorized`), sin permiso de
 *   insights (`forbidden`), límites (`rate_limited`), 5xx.
 *
 * https://developers.facebook.com/docs/graph-api/guides/error-handling
 */
export function graphReadError(result: HttpResult, source: string): "unavailable" {
  const err = graphErrorOf(result.json);
  if (err?.code === 100 && result.status < 500) return "unavailable";
  const outcome = classifyGraphError(result, { source, phase: "prepare" });
  if (outcome.kind === "throw") throw outcome.error;
  const reason = outcome.status.failure?.reason;
  if (reason === "permissions_missing") {
    throw new PortError(
      "forbidden",
      "The connected account didn't grant permission to read insights. Reconnect it.",
      { source, cause: { status: result.status, code: err?.code } },
    );
  }
  throw new PortError(
    "provider_contract_violation",
    "The platform rejected the insights request.",
    { source, cause: { status: result.status, code: err?.code, subcode: err?.subcode } },
  );
}

/**
 * Las métricas de una respuesta de insights de Meta, por nombre.
 *
 * Forma documentada (IG Media Insights, Threads Media Insights, Video
 * Insights): `{"data":[{"name":"likes","period":"lifetime","values":[{"value":12}],…}]}`.
 * IG también documenta `total_value.value`; se acepta cualquiera de las dos.
 * El valor puede no ser un número (los de Facebook Reels por tipo de
 * reacción): se devuelve crudo y lo interpreta cada adaptador.
 */
export function insightsByName(json: unknown, source: string): Map<string, unknown> {
  const data = field(json, "data");
  if (!Array.isArray(data)) {
    throw new PortError(
      "provider_contract_violation",
      "The platform answered with something unexpected.",
      { source, cause: { what: "insights sin data[]" } },
    );
  }
  const out = new Map<string, unknown>();
  for (const entry of data as unknown[]) {
    const name = field(entry, "name");
    if (typeof name !== "string") continue;
    const values = field(entry, "values");
    const first: unknown = Array.isArray(values) ? (values as unknown[])[0] : undefined;
    const value = field(first, "value") ?? field(entry, "total_value", "value");
    if (value !== undefined) out.set(name, value);
  }
  return out;
}

/** Un conteo: entero no negativo. Cualquier otra cosa es «no vino». */
export function count(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value);
}

/** Suma de los definidos; `undefined` si ninguno lo está. */
export function sumDefined(
  ...values: readonly (number | undefined)[]
): number | undefined {
  const defined = values.filter((v): v is number => v !== undefined);
  return defined.length === 0 ? undefined : defined.reduce((a, b) => a + b, 0);
}

/**
 * Corre `task` sobre cada id con a lo sumo `limit` en vuelo. Las Graph API de
 * Meta piden insights **de a un post**: sin tope, un lote de 100 serían 100
 * requests simultáneos contra el mismo token.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await task(items[i] as T);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Un snapshot sin claves `undefined` (`exactOptionalPropertyTypes`): una
 * métrica que no vino **no está**, no está con valor `undefined`.
 */
export function snapshotOf(values: {
  readonly views?: number | undefined;
  readonly likes?: number | undefined;
  readonly comments?: number | undefined;
  readonly shares?: number | undefined;
}): {
  views?: number;
  likes?: number;
  comments?: number;
  shares?: number;
} {
  const out: { views?: number; likes?: number; comments?: number; shares?: number } = {};
  if (values.views !== undefined) out.views = values.views;
  if (values.likes !== undefined) out.likes = values.likes;
  if (values.comments !== undefined) out.comments = values.comments;
  if (values.shares !== undefined) out.shares = values.shares;
  return out;
}
