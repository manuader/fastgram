/**
 * La vuelta del OAuth de Reddit — lógica pura de
 * `app/(app)/engagement/reddit/callback/route.ts` (`F-190`).
 *
 * Mismo esquema que `lib/connections/callback.ts`: el `code` no llega a ningún
 * JavaScript de la página; el route handler lo reenvía a
 * `POST /api/v1/engagement/reddit/callback` desde el servidor y manda al
 * navegador a `/engagement/actions` con sólo códigos estables en la URL.
 *
 * La redirect URI es `/engagement/reddit/callback` (no `/api/fastgram/oauth/…`)
 * porque Reddit no es una red de `OAUTH_PLATFORMS` (ver
 * `packages/core/src/connections/reddit.ts`). La documentación de Reddit no
 * exige https para la redirect URI, así que `http://localhost:3000` sirve.
 */
import { ROUTES } from "@/lib/nav/routes";

export const REDDIT_CALLBACK_PATH = "/engagement/reddit/callback";

export type RedditCallbackOutcome =
  | { readonly kind: "connected"; readonly username: string }
  | { readonly kind: "error"; readonly reason: string };

const REASON = /^[a-z_]{1,64}$/;
const USERNAME = /^[A-Za-z0-9_-]{1,32}$/;

export function redditOutcomeFromApi(
  status: number,
  body: unknown,
): RedditCallbackOutcome {
  const env = (body ?? {}) as {
    data?: { username?: unknown };
    error?: { code?: unknown; details?: { reason?: unknown } };
  };
  if (status >= 200 && status < 300) {
    const u = env.data?.username;
    return typeof u === "string" && USERNAME.test(u)
      ? { kind: "connected", username: u }
      : { kind: "error", reason: "invalid_response" };
  }
  const reason = env.error?.details?.reason ?? env.error?.code;
  return {
    kind: "error",
    reason:
      typeof reason === "string" && REASON.test(reason) ? reason : "service_unavailable",
  };
}

/** `/engagement/actions?reddit=connected&username=…` o `?reddit=error&reason=…`. */
export function redditReturnPath(outcome: RedditCallbackOutcome): string {
  const q = new URLSearchParams();
  if (outcome.kind === "connected") {
    q.set("reddit", "connected");
    q.set("username", outcome.username);
  } else {
    q.set("reddit", "error");
    q.set("reason", outcome.reason);
  }
  return `${ROUTES.engagementActions}?${q.toString()}`;
}
