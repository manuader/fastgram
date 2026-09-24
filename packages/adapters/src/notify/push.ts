/**
 * Avisos fuera de la app — `P5-NOTIF-003` (sprint 7: ntfy y Telegram en vez
 * de email, que en uso personal no tiene proveedor).
 *
 * ## Los dos endpoints, como los documenta cada proyecto
 *
 * - **ntfy** — https://docs.ntfy.sh/publish/ : `POST` (o `PUT`) a la URL del
 *   topic con el mensaje en el cuerpo. Cabeceras opcionales `Title`,
 *   `Priority` (1–5), `Tags` y `Click` (URL que abre al tocar). Servidores
 *   con control de acceso: `Authorization: Bearer <token>`
 *   (https://docs.ntfy.sh/publish/#access-tokens).
 *   **Decisión conservadora:** el cuerpo va en UTF-8 (ntfy lo acepta así),
 *   pero las cabeceras HTTP sólo llevan ASCII — un título con acentos o emoji
 *   no va en `Title` sino como primera línea del cuerpo. La doc menciona
 *   codificaciones alternativas para cabeceras no ASCII; no las verificamos,
 *   así que no se usan.
 * - **Telegram** — https://core.telegram.org/bots/api#sendmessage :
 *   `POST https://api.telegram.org/bot<token>/sendMessage` con JSON
 *   `{chat_id, text}`; responde `{ok: true, result}` o
 *   `{ok: false, error_code, description}`. `text` hasta 4096 caracteres.
 *   Sin `parse_mode`: texto plano, así no hay nada que escapar.
 *
 * ## Lo que nunca sale de acá
 *
 * La URL de Telegram **lleva el token**. Ningún error de este módulo incluye
 * la URL, el cuerpo de la respuesta ni la `description` del proveedor: sólo
 * un código estable ({@link PushErrorCode}) y, como mucho, el status HTTP.
 */

export type PushErrorCode =
  /** Token inválido o revocado, o el bot no puede escribirle a ese chat. */
  | "unauthorized"
  /** Topic o chat inexistente. */
  | "not_found"
  | "rate_limited"
  /** El proveedor rechazó el pedido (mensaje inválido, chat id mal formado). */
  | "bad_request"
  | "unavailable"
  | "timeout";

export type PushResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: PushErrorCode; readonly status?: number };

export interface PushMessage {
  readonly title: string;
  readonly body: string;
  readonly severity: "info" | "success" | "warning" | "error";
  /** URL absoluta para abrir al tocar. `null` = sin link. */
  readonly clickUrl: string | null;
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface PushTransportOptions {
  readonly fetch?: FetchLike;
  readonly timeoutMs?: number;
}

export const PUSH_TIMEOUT_MS = 10_000;
export const TELEGRAM_API_BASE = "https://api.telegram.org";
export const TELEGRAM_TEXT_MAX = 4096;

const PRINTABLE_ASCII = /^[\x20-\x7E]*$/u;

function statusCode(status: number): PushErrorCode {
  if (status === 401 || status === 403) return "unauthorized";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status >= 400 && status < 500) return "bad_request";
  return "unavailable";
}

async function send(
  url: string,
  init: RequestInit,
  options: PushTransportOptions,
): Promise<Response | PushResult> {
  const doFetch: FetchLike = options.fetch ?? ((input, i) => fetch(input, i));
  try {
    return await doFetch(url, {
      ...init,
      signal: AbortSignal.timeout(options.timeoutMs ?? PUSH_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (error) {
    const name = (error as { name?: unknown } | null)?.name;
    return {
      ok: false,
      code: name === "TimeoutError" || name === "AbortError" ? "timeout" : "unavailable",
    };
  }
}

const isResponse = (v: Response | PushResult): v is Response =>
  typeof (v as Response).status === "number" && "headers" in v;

/* ------------------------------------------------------------------------ *
 * ntfy
 * ------------------------------------------------------------------------ */

export interface NtfyTarget {
  readonly url: string;
  readonly token?: string | undefined;
}

const NTFY_PRIORITY: Readonly<Record<PushMessage["severity"], string>> = {
  info: "3",
  success: "3",
  warning: "4",
  error: "4",
};

const NTFY_TAGS: Readonly<Record<PushMessage["severity"], string>> = {
  info: "information_source",
  success: "white_check_mark",
  warning: "warning",
  error: "rotating_light",
};

export async function sendNtfy(
  target: NtfyTarget,
  message: PushMessage,
  options: PushTransportOptions = {},
): Promise<PushResult> {
  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    Priority: NTFY_PRIORITY[message.severity],
    Tags: NTFY_TAGS[message.severity],
  };
  let body = message.body;
  const title = message.title.replace(/[\r\n]+/gu, " ");
  if (PRINTABLE_ASCII.test(title)) headers["Title"] = title;
  else body = `${title}\n${body}`;
  if (message.clickUrl !== null && PRINTABLE_ASCII.test(message.clickUrl)) {
    headers["Click"] = message.clickUrl;
  }
  if (target.token !== undefined && target.token !== "") {
    headers["Authorization"] = `Bearer ${target.token}`;
  }

  const res = await send(target.url, { method: "POST", headers, body }, options);
  if (!isResponse(res)) return res;
  // El cuerpo no se lee ni se devuelve: no hace falta y no tiene que viajar.
  await res.body?.cancel().catch(() => undefined);
  if (res.ok) return { ok: true };
  return { ok: false, code: statusCode(res.status), status: res.status };
}

/* ------------------------------------------------------------------------ *
 * Telegram
 * ------------------------------------------------------------------------ */

export interface TelegramTarget {
  readonly botToken: string;
  readonly chatId: string;
  /** Para tests; default {@link TELEGRAM_API_BASE}. */
  readonly apiBase?: string;
}

export function telegramText(message: PushMessage): string {
  const parts = [message.title, message.body];
  if (message.clickUrl !== null) parts.push(message.clickUrl);
  const text = parts.filter((p) => p.trim() !== "").join("\n\n");
  return text.length <= TELEGRAM_TEXT_MAX
    ? text
    : `${text.slice(0, TELEGRAM_TEXT_MAX - 1)}…`;
}

export async function sendTelegram(
  target: TelegramTarget,
  message: PushMessage,
  options: PushTransportOptions = {},
): Promise<PushResult> {
  // El token va en el path. Se valida antes para que nunca pueda meter `/`,
  // `?` o `#` y apuntar a otro método u otro host.
  if (!/^\d+:[A-Za-z0-9_-]+$/u.test(target.botToken)) {
    return { ok: false, code: "unauthorized" };
  }
  const base = target.apiBase ?? TELEGRAM_API_BASE;
  const res = await send(
    `${base}/bot${target.botToken}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: target.chatId, text: telegramText(message) }),
    },
    options,
  );
  if (!isResponse(res)) return res;

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    payload = null;
  }
  const ok =
    typeof payload === "object" &&
    payload !== null &&
    (payload as { ok?: unknown }).ok === true;
  if (res.ok && ok) return { ok: true };
  // Telegram contesta 404 cuando el token no existe (el método "no existe"
  // para ese bot): para el usuario eso es "el token está mal".
  const code: PushErrorCode =
    res.status === 404 ? "unauthorized" : statusCode(res.status);
  return { ok: false, code: res.ok ? "unavailable" : code, status: res.status };
}
