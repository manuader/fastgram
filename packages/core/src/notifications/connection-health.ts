/**
 * ¿Hay que reconectar esta cuenta, ya o pronto? — `P3-OAUTH-005` (LinkedIn a
 * 60 días), `P3-OAUTH-011`, PRD §13.2 N-09/N-10/N-11.
 *
 * ## La fecha que importa no es siempre la del access token
 *
 * La que obliga al humano a reconectar es la **última** fecha hasta la que la
 * app puede seguir sola:
 *
 * - Con refresh token (TikTok, X, YouTube): el vencimiento del **refresh
 *   token** (`refreshTokenExpiry`; TikTok da 365 días). Si la plataforma no
 *   lo informa, no hay fecha que avisar.
 * - Instagram y Threads no tienen refresh token: el token largo (60 días) se
 *   renueva **usándolo** después de 24 h (`platforms.ts`). Si nadie publica
 *   en la última semana, vence. La fecha es `tokenExpiry`.
 * - Facebook Page: el token de Página no vence; `tokenExpiry` suele ser `null`.
 * - LinkedIn: 60 días y sin refresh token para apps no socias. Si la conexión
 *   no guardó `tokenExpiry`, se estima desde `tokenIssuedAt` + 60 días.
 *
 * Cualquier estado distinto de `active` (`expired`, `revoked`, `paused`) es
 * "vencida": el publicador ya la marcó así y los posts esperan en
 * `AWAITING_RECONNECT`.
 *
 * La ventana de "por vencer" (7 días) es nuestra: coincide con el margen de
 * refresco de Instagram/Threads, así que un aviso ahí significa que el
 * refresco automático no ocurrió.
 */

export const CONNECTION_EXPIRING_WINDOW_DAYS = 7;
export const LINKEDIN_TOKEN_LIFETIME_DAYS = 60;

const DAY_MS = 86_400_000;

export interface ConnectionHealthInput {
  readonly platform: string;
  readonly status: string;
  readonly tokenExpiry: Date | null;
  readonly refreshTokenExpiry: Date | null;
  readonly tokenIssuedAt: Date | null;
  readonly hasRefreshToken: boolean;
}

export type ConnectionHealth =
  | { readonly state: "ok"; readonly deadline: Date | null }
  | { readonly state: "expired"; readonly reason: string }
  | { readonly state: "expiring"; readonly deadline: Date };

/** La fecha límite para reconectar, o `null` si no hay ninguna conocida. */
export function reconnectDeadline(c: ConnectionHealthInput): Date | null {
  if (c.hasRefreshToken) return c.refreshTokenExpiry;
  if (c.tokenExpiry !== null) return c.tokenExpiry;
  if (c.platform === "linkedin" && c.tokenIssuedAt !== null) {
    return new Date(c.tokenIssuedAt.getTime() + LINKEDIN_TOKEN_LIFETIME_DAYS * DAY_MS);
  }
  return null;
}

export function assessConnectionHealth(
  c: ConnectionHealthInput,
  nowMs: number,
): ConnectionHealth {
  if (c.status !== "active") return { state: "expired", reason: c.status };
  const deadline = reconnectDeadline(c);
  if (deadline === null) return { state: "ok", deadline: null };
  if (deadline.getTime() <= nowMs) return { state: "expired", reason: "token_expired" };
  if (deadline.getTime() - nowMs <= CONNECTION_EXPIRING_WINDOW_DAYS * DAY_MS) {
    return { state: "expiring", deadline };
  }
  return { state: "ok", deadline };
}
