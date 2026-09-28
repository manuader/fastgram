/**
 * El resultado del login de anuncios, de la respuesta de la API a la query de
 * `/ads` (`?connect=pending` o `?connect=error&reason=…`). Sólo motivos con
 * forma de código: nada del texto de Meta ni de la API llega a la URL.
 */
export type AdsCallbackOutcome =
  { readonly kind: "pending" } | { readonly kind: "error"; readonly reason: string };

const REASON = /^[a-z_]{1,64}$/u;

export const ADS_PATH = "/ads";

export function adsOutcomeFromApi(status: number, body: unknown): AdsCallbackOutcome {
  if (status >= 200 && status < 300) return { kind: "pending" };
  const env = (body ?? {}) as {
    error?: { code?: unknown; details?: { reason?: unknown } };
  };
  const reason = env.error?.details?.reason ?? env.error?.code;
  return {
    kind: "error",
    reason: typeof reason === "string" && REASON.test(reason) ? reason : "unknown",
  };
}

export function adsReturnPath(outcome: AdsCallbackOutcome): string {
  const q = new URLSearchParams(
    outcome.kind === "pending"
      ? { connect: "pending" }
      : { connect: "error", reason: outcome.reason },
  );
  return `${ADS_PATH}?${q.toString()}`;
}
