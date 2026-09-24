/**
 * La vuelta del OAuth — lógica pura de
 * `app/api/fastgram/oauth/[platform]/callback/route.ts` (`PU-PUB-002`).
 *
 * La plataforma redirige el navegador acá con `code` y `state` en la query.
 * El route handler reenvía los dos a `POST /api/v1/connections/:platform/callback`
 * **desde el servidor** (con la key de la web) y manda al navegador a
 * `/settings/connections` con el resultado en la query. El `code` no llega a
 * ningún JavaScript de la página, y los tokens no salen de la API.
 *
 * ## Qué marca se usa
 *
 * La de la cookie `fg_workspace` si la hay: si el usuario cambió de marca en
 * medio del login, la API lo rechaza (`oauth_state_wrong_brand`) y eso es lo
 * correcto. Si **no** hay cookie —el callback llega por el túnel
 * (`FASTGRAM_PUBLIC_URL`), otro dominio sin las cookies de `localhost`— se usa
 * la marca que viaja dentro del `state`. No da ningún permiso: la API verifica
 * la firma del `state`, que la marca sea del dueño de la key y que el nonce no
 * se haya usado.
 *
 * ## Por qué no exige la sesión de la shell
 *
 * Por la misma razón: por el túnel no hay cookie de sesión. Lo que protege al
 * callback es el `state` firmado, de un solo uso y con vencimiento, no la
 * cookie (que además hoy no está firmada, ver `lib/auth/session.ts`).
 */
import { isWorkspaceId } from "../brands/workspace-cookie";

export const OAUTH_PLATFORM_IDS = [
  "instagram",
  "tiktok",
  "x",
  "threads",
  "facebook",
  "youtube",
  "linkedin",
] as const;
export type OAuthPlatformId = (typeof OAUTH_PLATFORM_IDS)[number];

export function isOAuthPlatformId(value: string): value is OAuthPlatformId {
  return (OAUTH_PLATFORM_IDS as readonly string[]).includes(value);
}

export const CONNECTIONS_PATH = "/settings/connections";
export const LOCAL_APP_ORIGIN = "http://localhost:3000";

export interface CallbackBody {
  readonly state: string;
  readonly code?: string;
  readonly error?: string;
  readonly errorDescription?: string;
}

/** Topes del contrato (`connectionCallbackRequestSchema`). */
const MAX = { state: 2048, code: 4096, error: 256, errorDescription: 1024 } as const;

/** La query de la plataforma → el cuerpo para la API. `null` si no hay `state`. */
export function callbackBodyFrom(params: URLSearchParams): CallbackBody | null {
  const state = params.get("state");
  if (state === null || state === "" || state.length > MAX.state) return null;
  const pick = (key: string, max: number): string | undefined => {
    const v = params.get(key);
    return v === null || v === "" ? undefined : v.slice(0, max);
  };
  const code = pick("code", MAX.code);
  const error = pick("error", MAX.error);
  const errorDescription = pick("error_description", MAX.errorDescription);
  return {
    state,
    ...(code === undefined ? {} : { code }),
    ...(error === undefined ? {} : { error }),
    ...(errorDescription === undefined ? {} : { errorDescription }),
  };
}

/**
 * La marca que viaja en el `state` (`v1.<base64url(json)>.<mac>`, ver
 * `packages/core/src/connections/state.ts`). **Sin verificar**: sólo sirve para
 * elegir el header; la API es la que verifica.
 */
export function brandFromState(state: string): string | null {
  const parts = state.split(".");
  if (parts.length !== 3 || parts[0] !== "v1" || parts[1] === undefined) return null;
  try {
    const json: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const c = (json as { c?: unknown }).c;
    return typeof c === "string" && isWorkspaceId(c) ? c : null;
  } catch {
    return null;
  }
}

export function workspaceForCallback(
  cookieValue: string | undefined,
  state: string,
): string | null {
  if (isWorkspaceId(cookieValue)) return cookieValue.toLowerCase();
  return brandFromState(state);
}

/**
 * A dónde volver. Si el callback llegó por el túnel, a la app local
 * (`FASTGRAM_APP_ORIGIN` o `http://localhost:3000`), que es donde están la
 * sesión y la marca activa; si no, al mismo origen.
 */
export function returnOrigin(
  requestOrigin: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const appOrigin = env["FASTGRAM_APP_ORIGIN"]?.trim();
  const publicUrl = env["FASTGRAM_PUBLIC_URL"]?.trim();
  let viaTunnel = false;
  if (publicUrl !== undefined && publicUrl !== "") {
    try {
      viaTunnel = new URL(publicUrl).origin === requestOrigin;
    } catch {
      viaTunnel = false;
    }
  }
  if (!viaTunnel) return requestOrigin;
  if (appOrigin !== undefined && appOrigin !== "") {
    try {
      return new URL(appOrigin).origin;
    } catch {
      // cae al default
    }
  }
  return LOCAL_APP_ORIGIN;
}

/** El sobre de la API, leído sin confiar en él. */
export type CallbackOutcome =
  | { readonly kind: "connected"; readonly platform: OAuthPlatformId }
  | {
      readonly kind: "choose_page";
      readonly selectionId: string;
      /** Facebook (Páginas) o LinkedIn (perfil y Páginas). */
      readonly platform: OAuthPlatformId;
    }
  | {
      readonly kind: "error";
      readonly platform: OAuthPlatformId;
      readonly reason: string;
    };

export function outcomeFromApi(
  platform: OAuthPlatformId,
  status: number,
  body: unknown,
): CallbackOutcome {
  const env = (body ?? {}) as {
    data?: { kind?: unknown; selectionId?: unknown };
    error?: { code?: unknown; details?: { reason?: unknown } };
  };
  if (status >= 200 && status < 300) {
    if (env.data?.kind === "choose_page" && typeof env.data.selectionId === "string") {
      return { kind: "choose_page", selectionId: env.data.selectionId, platform };
    }
    if (env.data?.kind === "connected") return { kind: "connected", platform };
  }
  const reason = env.error?.details?.reason;
  const code = env.error?.code;
  return {
    kind: "error",
    platform,
    reason:
      typeof reason === "string" && /^[a-z_]{1,64}$/.test(reason)
        ? reason
        : typeof code === "string" && /^[a-z_]{1,64}$/.test(code)
          ? code
          : "oauth_exchange_failed",
  };
}

/** `/settings/connections?…` con el resultado. Sólo códigos estables en la URL. */
export function returnPath(outcome: CallbackOutcome): string {
  const q = new URLSearchParams();
  switch (outcome.kind) {
    case "connected":
      q.set("connected", outcome.platform);
      break;
    case "choose_page":
      q.set("select", outcome.selectionId);
      q.set("platform", outcome.platform);
      break;
    case "error":
      q.set("error", outcome.reason);
      q.set("platform", outcome.platform);
      break;
  }
  return `${CONNECTIONS_PATH}?${q.toString()}`;
}
