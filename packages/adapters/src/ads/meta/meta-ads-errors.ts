/**
 * Errores de la Marketing API → `AdsPlatformError` con motivo estable.
 *
 * Fuentes (consultadas el 2026-09-28):
 *  - https://developers.facebook.com/docs/marketing-api/error-reference
 *    (100 invalid parameter, 10/200/294 permisos, 4/17 límites, 102/104/190
 *    sesión, 1885272 *"Budget is too low"*, 1885650, 2446307, 1404163,
 *    1404078, 2708008, 100/3858258 imagen no descargable).
 *  - https://developers.facebook.com/docs/marketing-api/overview/rate-limiting
 *    (throttling: 17, 80000, 80003, 80004, 80014, 4, 613, 32; header
 *    `X-Business-Use-Case-Usage` con `estimated_time_to_regain_access`).
 *  - https://developers.facebook.com/docs/graph-api/guides/error-handling
 *    (forma `{"error":{"message","type","code","error_subcode","fbtrace_id"}}`).
 *
 * **Nada del cuerpo de Meta sale**: va a `cause` (código, subcódigo, status),
 * sin el `message`, que puede nombrar ids de la cuenta.
 */
import { AdsPlatformError, type AdsErrorReason } from "@fastgram/ports";

import { graphErrorOf } from "../../publishers/meta/graph-errors.js";
import type { HttpResult } from "../../publishers/shared/http.js";

const AUTH_CODES = new Set([102, 104, 190]);
const PERMISSION_CODES = new Set([10, 294]);
const RATE_CODES = new Set([4, 17, 32, 613, 80000, 80003, 80004, 80014]);
const BUDGET_SUBCODES = new Set([1885272, 1885650, 2446307]);
const ACCOUNT_SUBCODES = new Set([1404163, 1404078, 2708008]);
/** 3858258: *"Image download failed"*. 382 (código): video demasiado chico. */
const MEDIA_SUBCODES = new Set([3858258]);
const MEDIA_CODES = new Set([382]);

const MESSAGES: Readonly<Record<AdsErrorReason, string>> = {
  unauthorized: "The ad account connection expired. Reconnect it.",
  permission_missing: "The ad account connection is missing a permission. Reconnect it.",
  rate_limited: "Meta asked to slow down. Try again later.",
  invalid_parameter: "Meta rejected a campaign setting.",
  budget_too_low: "The budget is below Meta's minimum for this account.",
  account_disabled: "The ad account is disabled or restricted.",
  media_rejected: "Meta couldn't use this media file.",
  not_found: "Meta doesn't know this object.",
  provider_unavailable: "Meta is having trouble right now.",
  unexpected_response: "Meta answered something unexpected.",
};

export function adsError(
  reason: AdsErrorReason,
  source: string,
  cause?: unknown,
  retryAfterSeconds?: number,
): AdsPlatformError {
  return new AdsPlatformError(reason, MESSAGES[reason], {
    source,
    ...(cause === undefined ? {} : { cause }),
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
  });
}

/**
 * `estimated_time_to_regain_access` (minutos) del header BUC, el máximo entre
 * las cuentas y los tipos que vengan. Forma documentada:
 * `{"<business-id>": [{"type": "ads_insights", "call_count": 28, …,
 * "estimated_time_to_regain_access": 0}]}`.
 */
export function regainSecondsOf(headers: Headers): number | undefined {
  const raw =
    headers.get("x-business-use-case-usage") ?? headers.get("x-business-use-case");
  let best: number | undefined;
  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null) {
        for (const list of Object.values(parsed as Record<string, unknown>)) {
          if (!Array.isArray(list)) continue;
          for (const item of list as unknown[]) {
            const m =
              typeof item === "object" && item !== null
                ? (item as Record<string, unknown>)["estimated_time_to_regain_access"]
                : undefined;
            if (typeof m === "number" && m > 0) best = Math.max(best ?? 0, m * 60);
          }
        }
      }
    } catch {
      // Header ilegible: sin pista de cuándo volver.
    }
  }
  if (best !== undefined) return best;
  const retry = headers.get("retry-after");
  const n = retry === null ? Number.NaN : Number(retry);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

export function classifyAdsError(result: HttpResult, source: string): AdsPlatformError {
  const err = graphErrorOf(result.json);
  const code = err?.code;
  const subcode = err?.subcode;
  const cause = { status: result.status, code, subcode };

  if ((code !== undefined && AUTH_CODES.has(code)) || result.status === 401)
    return adsError("unauthorized", source, cause);
  if (code !== undefined && RATE_CODES.has(code))
    return adsError("rate_limited", source, cause, regainSecondsOf(result.headers));
  if (result.status === 429)
    return adsError("rate_limited", source, cause, regainSecondsOf(result.headers));
  if (subcode !== undefined && BUDGET_SUBCODES.has(subcode))
    return adsError("budget_too_low", source, cause);
  if (subcode !== undefined && ACCOUNT_SUBCODES.has(subcode))
    return adsError("account_disabled", source, cause);
  if (
    (subcode !== undefined && MEDIA_SUBCODES.has(subcode)) ||
    (code !== undefined && MEDIA_CODES.has(code))
  )
    return adsError("media_rejected", source, cause);
  if (
    (code !== undefined && PERMISSION_CODES.has(code)) ||
    (code !== undefined && code >= 200 && code <= 299)
  )
    return adsError("permission_missing", source, cause);
  // Graph API: 100/33 = el objeto no existe o no se puede cargar por permisos.
  if ((code === 100 && subcode === 33) || code === 803 || result.status === 404)
    return adsError("not_found", source, cause);
  if (code === 1 || code === 2 || result.status >= 500)
    return adsError(
      "provider_unavailable",
      source,
      cause,
      regainSecondsOf(result.headers),
    );
  if (code === 100 || result.status === 400)
    return adsError("invalid_parameter", source, cause);
  return adsError("unexpected_response", source, cause);
}
