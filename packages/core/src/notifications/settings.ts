/**
 * Preferencias y canales de notificación — `P5-NOTIF-002/003`.
 *
 * ## Dónde viven y por qué
 *
 * En `${FASTGRAM_HOME:-~/.fastgram}/notifications.json`, `0600`, igual que
 * `models.json`: adentro va el **token del bot de Telegram** (y el de ntfy si
 * el servidor lo pide), que es un secreto; y las preferencias son de la
 * instalación (un dueño, D-06), no de una marca. La API escribe; el worker
 * lee en cada vuelta del despachador.
 *
 * Este módulo es puro: parsea el documento (que llega como `unknown` desde el
 * archivo), aplica una actualización, valida y **enmascara** para la API. El
 * I/O es de `packages/adapters` (`notify/settings-file.ts`).
 *
 * ## Canales
 *
 * - **ntfy** — `POST` a la URL del topic (`https://ntfy.sh/<topic>` o un
 *   servidor propio). El topic de ntfy.sh es público para quien lo adivine:
 *   se trata como secreto (se enmascara) y conviene uno largo y aleatorio.
 *   Token opcional para servidores con control de acceso.
 * - **Telegram** — Bot API `sendMessage` con el token de un bot propio
 *   (@BotFather) y el `chat_id` del dueño.
 *
 * El "email transaccional" de `P5-NOTIF-003` queda fuera: en uso personal no
 * hay proveedor de email configurado, y ntfy/Telegram llegan al teléfono sin
 * cuenta de terceros (decisión del brief del sprint 7).
 */
import {
  DEFAULT_CATEGORY_PREFERENCES,
  NOTIFICATION_CATEGORIES,
  isNotificationCategory,
  type CategoryPreference,
  type NotificationCategory,
} from "./categories.js";

export const NOTIFICATION_SETTINGS_VERSION = 1;
/** Hora local (de cada marca) a partir de la cual sale el resumen diario. */
export const DEFAULT_DAILY_SUMMARY_HOUR = 8;

export interface NtfyChannel {
  readonly enabled: boolean;
  /** URL completa del topic. */
  readonly url: string;
  /** Token de acceso de un servidor propio (`tk_…`). Opcional. */
  readonly token?: string;
}

export interface TelegramChannel {
  readonly enabled: boolean;
  readonly botToken: string;
  readonly chatId: string;
}

export interface NotificationSettings {
  readonly categories: Readonly<Record<NotificationCategory, CategoryPreference>>;
  readonly ntfy: NtfyChannel | null;
  readonly telegram: TelegramChannel | null;
  readonly dailySummaryHour: number;
}

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  categories: DEFAULT_CATEGORY_PREFERENCES,
  ntfy: null,
  telegram: null,
  dailySummaryHour: DEFAULT_DAILY_SUMMARY_HOUR,
};

export type NotificationChannelId = "ntfy" | "telegram";

/* ------------------------------------------------------------------------ *
 * Validación
 * ------------------------------------------------------------------------ */

/**
 * `http(s)`, con host y con un path que no sea sólo `/` (el topic). `http` se
 * acepta para un ntfy self-hosted en la red local; el de ntfy.sh es https.
 */
export function checkNtfyUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return "Enter the full topic URL, like https://ntfy.sh/your-topic.";
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return "The topic URL must start with https:// (or http:// for a server on your network).";
  }
  if (url.username !== "" || url.password !== "") {
    return "Don't put credentials in the URL — use the access token field.";
  }
  const topic = url.pathname.replace(/\/+$/u, "").split("/").pop() ?? "";
  if (topic === "")
    return "The URL needs a topic at the end, like https://ntfy.sh/your-topic.";
  // ntfy: letras, números, `_` y `-`, hasta 64 (docs.ntfy.sh/publish).
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(topic)) {
    return "Topic names can only have letters, numbers, _ and - (up to 64).";
  }
  if (url.search !== "" || url.hash !== "")
    return "Remove the ?query or #fragment from the URL.";
  return null;
}

/** El formato de token que da @BotFather: `<id numérico>:<35 caracteres>`. */
export function checkTelegramBotToken(value: string): string | null {
  return /^\d{5,}:[A-Za-z0-9_-]{20,}$/u.test(value.trim())
    ? null
    : "That doesn't look like a bot token from @BotFather (123456:ABC…).";
}

/** Un chat id numérico (negativo en grupos) o un `@canal` público. */
export function checkTelegramChatId(value: string): string | null {
  return /^(-?\d{1,20}|@[A-Za-z0-9_]{5,32})$/u.test(value.trim())
    ? null
    : "The chat id is a number (like 123456789) or @channelname.";
}

/* ------------------------------------------------------------------------ *
 * Parseo del documento
 * ------------------------------------------------------------------------ */

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export type ParsedNotificationSettings =
  | { readonly ok: true; readonly settings: NotificationSettings }
  | { readonly ok: false; readonly reason: string };

/**
 * `null` (no hay archivo) = los defaults. Un documento con otra forma **no se
 * repara**: puede tener un token que el dueño no tiene en otro lado, y
 * pisarlo con los defaults lo borraría (mismo criterio que `models.json`).
 */
export function parseNotificationSettings(raw: unknown): ParsedNotificationSettings {
  if (raw === null || raw === undefined) {
    return { ok: true, settings: DEFAULT_NOTIFICATION_SETTINGS };
  }
  if (!isRecord(raw) || raw["version"] !== NOTIFICATION_SETTINGS_VERSION) {
    return { ok: false, reason: "unexpected version or shape" };
  }

  const categories: Record<NotificationCategory, CategoryPreference> = {
    ...DEFAULT_CATEGORY_PREFERENCES,
  };
  const rawCats = raw["categories"];
  if (rawCats !== undefined) {
    if (!isRecord(rawCats)) return { ok: false, reason: "categories" };
    for (const [key, value] of Object.entries(rawCats)) {
      // Una categoría que esta versión no conoce se ignora (una versión
      // futura la escribió); una conocida con forma rota, no.
      if (!isNotificationCategory(key)) continue;
      if (
        !isRecord(value) ||
        typeof value["inApp"] !== "boolean" ||
        typeof value["push"] !== "boolean"
      ) {
        return { ok: false, reason: `categories.${key}` };
      }
      categories[key] = { inApp: value["inApp"], push: value["push"] };
    }
  }

  let ntfy: NtfyChannel | null = null;
  const rawNtfy = raw["ntfy"];
  if (rawNtfy !== undefined && rawNtfy !== null) {
    if (
      !isRecord(rawNtfy) ||
      typeof rawNtfy["enabled"] !== "boolean" ||
      typeof rawNtfy["url"] !== "string" ||
      (rawNtfy["token"] !== undefined && typeof rawNtfy["token"] !== "string")
    ) {
      return { ok: false, reason: "ntfy" };
    }
    ntfy = {
      enabled: rawNtfy["enabled"],
      url: rawNtfy["url"],
      ...(typeof rawNtfy["token"] === "string" ? { token: rawNtfy["token"] } : {}),
    };
  }

  let telegram: TelegramChannel | null = null;
  const rawTg = raw["telegram"];
  if (rawTg !== undefined && rawTg !== null) {
    if (
      !isRecord(rawTg) ||
      typeof rawTg["enabled"] !== "boolean" ||
      typeof rawTg["botToken"] !== "string" ||
      typeof rawTg["chatId"] !== "string"
    ) {
      return { ok: false, reason: "telegram" };
    }
    telegram = {
      enabled: rawTg["enabled"],
      botToken: rawTg["botToken"],
      chatId: rawTg["chatId"],
    };
  }

  const hour = raw["dailySummaryHour"];
  const dailySummaryHour =
    typeof hour === "number" && Number.isInteger(hour) && hour >= 0 && hour <= 23
      ? hour
      : DEFAULT_DAILY_SUMMARY_HOUR;

  return { ok: true, settings: { categories, ntfy, telegram, dailySummaryHour } };
}

/** El documento que se escribe. Todas las categorías, explícitas. */
export function serializeNotificationSettings(
  settings: NotificationSettings,
): Record<string, unknown> {
  return {
    version: NOTIFICATION_SETTINGS_VERSION,
    categories: settings.categories,
    ntfy: settings.ntfy,
    telegram: settings.telegram,
    dailySummaryHour: settings.dailySummaryHour,
  };
}

/* ------------------------------------------------------------------------ *
 * Uso
 * ------------------------------------------------------------------------ */

export function categoryPreference(
  settings: NotificationSettings,
  category: NotificationCategory,
): CategoryPreference {
  return settings.categories[category];
}

/** Los canales prendidos y completos. */
export function enabledChannels(settings: NotificationSettings): NotificationChannelId[] {
  const out: NotificationChannelId[] = [];
  if (settings.ntfy?.enabled === true && checkNtfyUrl(settings.ntfy.url) === null) {
    out.push("ntfy");
  }
  if (
    settings.telegram?.enabled === true &&
    checkTelegramBotToken(settings.telegram.botToken) === null &&
    checkTelegramChatId(settings.telegram.chatId) === null
  ) {
    out.push("telegram");
  }
  return out;
}

/** Si un aviso de esta categoría tiene que salir por push. */
export function shouldPush(
  settings: NotificationSettings,
  category: NotificationCategory,
): boolean {
  return (
    categoryPreference(settings, category).push && enabledChannels(settings).length > 0
  );
}

/* ------------------------------------------------------------------------ *
 * Vista pública (API) — nunca un secreto entero
 * ------------------------------------------------------------------------ */

export interface PublicNotificationSettings {
  readonly categories: ReadonlyArray<{
    readonly category: NotificationCategory;
    readonly inApp: boolean;
    readonly push: boolean;
  }>;
  readonly ntfy: {
    readonly configured: boolean;
    readonly enabled: boolean;
    /** El topic enmascarado: `https://ntfy.sh/ab…yz`. */
    readonly urlMasked: string | null;
    readonly tokenSet: boolean;
  };
  readonly telegram: {
    readonly configured: boolean;
    readonly enabled: boolean;
    readonly chatId: string | null;
    /** Los últimos 4 del token: `…AbCd`. */
    readonly botTokenHint: string | null;
  };
  readonly dailySummaryHour: number;
}

export function maskSecret(value: string, keep = 2): string {
  if (value.length <= keep * 2 + 2) return "…";
  return `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

export function maskNtfyUrl(value: string): string {
  try {
    const url = new URL(value);
    const parts = url.pathname.split("/");
    const topic = parts.pop() ?? "";
    return `${url.origin}${parts.join("/")}/${maskSecret(topic)}`;
  } catch {
    return "…";
  }
}

export function toPublicNotificationSettings(
  settings: NotificationSettings,
): PublicNotificationSettings {
  return {
    categories: NOTIFICATION_CATEGORIES.map((category) => ({
      category,
      ...settings.categories[category],
    })),
    ntfy: {
      configured: settings.ntfy !== null,
      enabled: settings.ntfy?.enabled ?? false,
      urlMasked: settings.ntfy === null ? null : maskNtfyUrl(settings.ntfy.url),
      tokenSet: settings.ntfy?.token !== undefined,
    },
    telegram: {
      configured: settings.telegram !== null,
      enabled: settings.telegram?.enabled ?? false,
      chatId: settings.telegram?.chatId ?? null,
      botTokenHint:
        settings.telegram === null ? null : `…${settings.telegram.botToken.slice(-4)}`,
    },
    dailySummaryHour: settings.dailySummaryHour,
  };
}

/* ------------------------------------------------------------------------ *
 * Actualización
 * ------------------------------------------------------------------------ */

export interface NotificationSettingsUpdate {
  readonly categories?:
    | ReadonlyArray<{
        readonly category: NotificationCategory;
        readonly inApp?: boolean | undefined;
        readonly push?: boolean | undefined;
      }>
    | undefined;
  /**
   * `null` = borrar el canal. Un secreto ausente o vacío **conserva** el
   * guardado (la pantalla nunca lo tiene para reenviarlo).
   */
  readonly ntfy?:
    | {
        readonly enabled?: boolean | undefined;
        readonly url?: string | undefined;
        /** `null` borra el token. */
        readonly token?: string | null | undefined;
      }
    | null
    | undefined;
  readonly telegram?:
    | {
        readonly enabled?: boolean | undefined;
        readonly botToken?: string | undefined;
        readonly chatId?: string | undefined;
      }
    | null
    | undefined;
  readonly dailySummaryHour?: number | undefined;
}

export type NotificationSettingsUpdateResult =
  | { readonly ok: true; readonly settings: NotificationSettings }
  | { readonly ok: false; readonly field: string; readonly message: string };

const filled = (v: string | undefined | null): v is string =>
  typeof v === "string" && v.trim() !== "";

export function applyNotificationSettingsUpdate(
  current: NotificationSettings,
  update: NotificationSettingsUpdate,
): NotificationSettingsUpdateResult {
  const categories: Record<NotificationCategory, CategoryPreference> = {
    ...current.categories,
  };
  for (const c of update.categories ?? []) {
    const prev = categories[c.category];
    categories[c.category] = {
      inApp: c.inApp ?? prev.inApp,
      push: c.push ?? prev.push,
    };
  }

  let ntfy = current.ntfy;
  if (update.ntfy === null) {
    ntfy = null;
  } else if (update.ntfy !== undefined) {
    const url = filled(update.ntfy.url) ? update.ntfy.url.trim() : current.ntfy?.url;
    if (url === undefined) {
      return { ok: false, field: "ntfy.url", message: "Enter the topic URL." };
    }
    const urlProblem = checkNtfyUrl(url);
    if (urlProblem !== null) return { ok: false, field: "ntfy.url", message: urlProblem };
    const token =
      update.ntfy.token === null
        ? undefined
        : filled(update.ntfy.token)
          ? update.ntfy.token.trim()
          : current.ntfy?.token;
    ntfy = {
      enabled: update.ntfy.enabled ?? current.ntfy?.enabled ?? true,
      url,
      ...(token === undefined ? {} : { token }),
    };
  }

  let telegram = current.telegram;
  if (update.telegram === null) {
    telegram = null;
  } else if (update.telegram !== undefined) {
    const botToken = filled(update.telegram.botToken)
      ? update.telegram.botToken.trim()
      : current.telegram?.botToken;
    const chatId = filled(update.telegram.chatId)
      ? update.telegram.chatId.trim()
      : current.telegram?.chatId;
    if (botToken === undefined) {
      return { ok: false, field: "telegram.botToken", message: "Enter the bot token." };
    }
    if (chatId === undefined) {
      return { ok: false, field: "telegram.chatId", message: "Enter the chat id." };
    }
    const tokenProblem = checkTelegramBotToken(botToken);
    if (tokenProblem !== null) {
      return { ok: false, field: "telegram.botToken", message: tokenProblem };
    }
    const chatProblem = checkTelegramChatId(chatId);
    if (chatProblem !== null) {
      return { ok: false, field: "telegram.chatId", message: chatProblem };
    }
    telegram = {
      enabled: update.telegram.enabled ?? current.telegram?.enabled ?? true,
      botToken,
      chatId,
    };
  }

  const hour = update.dailySummaryHour ?? current.dailySummaryHour;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) {
    return {
      ok: false,
      field: "dailySummaryHour",
      message: "Pick an hour from 0 to 23.",
    };
  }

  return { ok: true, settings: { categories, ntfy, telegram, dailySummaryHour: hour } };
}
