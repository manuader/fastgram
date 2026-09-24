/**
 * Una llamada a una Graph API de Meta (Instagram, Threads, Facebook), con la
 * clasificación de errores de `graph-errors.ts`.
 *
 * El token viaja como lo muestra el ejemplo de la doc de cada producto:
 *  - Instagram: `Authorization: Bearer <ACCESS_TOKEN>` + cuerpo JSON
 *    (content-publishing).
 *  - Threads: `-d "access_token=…"` form-encoded
 *    (https://developers.facebook.com/docs/threads/posts) y `access_token` en
 *    la query de los GET (threads-media).
 *  - Facebook Reels: cuerpo JSON con `access_token` y query en los GET
 *    (https://developers.facebook.com/docs/video-api/guides/reels-publishing).
 */
import type { PublishStatus } from "@fastgram/ports";

import { classifyGraphError } from "./graph-errors.js";
import { call, type CallPhase, type PublisherFetch } from "../shared/http.js";

export type TokenPlacement = "bearer" | "form" | "json";

export interface GraphClientConfig {
  readonly fetch: PublisherFetch;
  /** `https://graph.instagram.com/v26.0`, sin barra final. */
  readonly base: string;
  readonly source: string;
  readonly timeoutMs: number;
  readonly tokenPlacement: TokenPlacement;
}

export type GraphResponse =
  | { readonly kind: "ok"; readonly json: unknown }
  | { readonly kind: "outcome"; readonly status: PublishStatus };

export async function graphCall(
  config: GraphClientConfig,
  request: {
    readonly method: "GET" | "POST";
    readonly path: string;
    readonly token: string;
    readonly phase: CallPhase;
    readonly params?: Readonly<Record<string, string>>;
  },
): Promise<GraphResponse> {
  const params = request.params ?? {};
  const headers: Record<string, string> = {};
  let url = `${config.base}${request.path}`;
  let body: string | undefined;

  if (request.method === "GET") {
    const query = new URLSearchParams(params);
    if (config.tokenPlacement === "bearer")
      headers["Authorization"] = `Bearer ${request.token}`;
    else query.set("access_token", request.token);
    const qs = query.toString();
    if (qs.length > 0) url += `${url.includes("?") ? "&" : "?"}${qs}`;
  } else if (config.tokenPlacement === "bearer") {
    headers["Authorization"] = `Bearer ${request.token}`;
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(params);
  } else if (config.tokenPlacement === "json") {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify({ ...params, access_token: request.token });
  } else {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams({ ...params, access_token: request.token }).toString();
  }

  const result = await call(
    config.fetch,
    url,
    { method: request.method, headers, ...(body === undefined ? {} : { body }) },
    { source: config.source, phase: request.phase, timeoutMs: config.timeoutMs },
  );
  if (result.status >= 200 && result.status < 300)
    return { kind: "ok", json: result.json };
  const outcome = classifyGraphError(result, {
    source: config.source,
    phase: request.phase,
  });
  if (outcome.kind === "throw") throw outcome.error;
  return { kind: "outcome", status: outcome.status };
}
