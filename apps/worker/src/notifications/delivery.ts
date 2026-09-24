/**
 * El despachador del push — `P5-NOTIF-003`. Toma los avisos `pending` de una
 * marca y los manda por los canales prendidos (ntfy, Telegram).
 *
 * - **Enviado** si llegó por al menos un canal (el que falló queda anotado en
 *   `push_error` como `canal:código`). Reintentar mandaría otra vez por el
 *   canal que sí funcionó.
 * - Si fallaron todos: `push_attempts + 1` y sigue `pending` hasta
 *   {@link PUSH_MAX_ATTEMPTS}; después `failed`.
 * - Un aviso más viejo que {@link PUSH_MAX_AGE_MS} no se manda (`failed` con
 *   `stale`): avisaría tarde algo que probablemente ya se resolvió.
 * - Si no queda ningún canal prendido, `skipped` (`no_channel`).
 *
 * El HTTP va **fuera** de la transacción: la tanda se lee en una transacción
 * corta y cada resultado se escribe en otra. Dos workers a la vez podrían
 * mandar el mismo aviso dos veces; la instalación personal corre uno (D-06) y
 * dentro del proceso el monitor no solapa vueltas.
 *
 * **Nunca** se loguea el destino (la URL de Telegram lleva el token): sólo el
 * canal y el código.
 */
import {
  PUSH_MAX_AGE_MS,
  PUSH_MAX_ATTEMPTS,
  enabledChannels,
  type NotificationSettings,
} from "@fastgram/core";
import {
  claimPendingPushes,
  recordPushOutcome,
  withCompany,
  type Database,
  type NotificationRow,
} from "@fastgram/db";
import type { PushMessage, PushResult, sendNtfy, sendTelegram } from "@fastgram/adapters";

import type { BuildLogger } from "../content/build-handler.js";

export interface DeliveryDeps {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly sendNtfy: typeof sendNtfy;
  readonly sendTelegram: typeof sendTelegram;
  /** Base de la web para el link del aviso (`FASTGRAM_WEB_URL`). */
  readonly webBaseUrl: string;
}

/** Espera antes del primer reintento; se duplica en cada uno. */
export const PUSH_RETRY_BASE_MS = 60_000;

/** Cuántos por marca y por vuelta. */
export const PUSH_BATCH = 10;

export function pushMessageOf(row: NotificationRow, webBaseUrl: string): PushMessage {
  return {
    title: row.title,
    body: row.body,
    severity: row.severity,
    clickUrl: row.link === null ? null : `${webBaseUrl}${row.link}`,
  };
}

export interface DeliveryResult {
  readonly sent: number;
  readonly failed: number;
  readonly retrying: number;
}

export async function deliverPendingPushes(
  deps: DeliveryDeps,
  companyId: string,
  nowMs: number,
  settings: NotificationSettings,
): Promise<DeliveryResult> {
  const opts = deps.appRole === undefined ? {} : { role: deps.appRole };
  const scope = { companyId };
  const batch = await withCompany(
    deps.db,
    companyId,
    (tx) => claimPendingPushes(tx, scope, PUSH_BATCH),
    opts,
  );
  const channels = enabledChannels(settings);
  let sent = 0;
  let failed = 0;
  let retrying = 0;

  for (const row of batch) {
    const now = new Date(nowMs);
    const record = (
      status: "sent" | "failed" | "pending" | "skipped",
      attempts: number,
      error: string | null,
    ) =>
      withCompany(
        deps.db,
        companyId,
        (tx) => recordPushOutcome(tx, scope, row.id, { status, attempts, error, now }),
        opts,
      );

    if (nowMs - row.createdAt.getTime() > PUSH_MAX_AGE_MS) {
      await record("failed", row.pushAttempts, "stale");
      failed += 1;
      continue;
    }
    // Backoff entre reintentos: 1, 2, 4, 8 minutos.
    if (
      row.pushAttempts > 0 &&
      nowMs - row.updatedAt.getTime() < PUSH_RETRY_BASE_MS * 2 ** (row.pushAttempts - 1)
    ) {
      continue;
    }
    if (channels.length === 0) {
      await record("skipped", row.pushAttempts, "no_channel");
      continue;
    }

    const message = pushMessageOf(row, deps.webBaseUrl);
    const results: Array<{ channel: string; result: PushResult }> = [];
    for (const channel of channels) {
      if (channel === "ntfy" && settings.ntfy !== null) {
        results.push({
          channel,
          result: await deps.sendNtfy(
            { url: settings.ntfy.url, token: settings.ntfy.token },
            message,
          ),
        });
      }
      if (channel === "telegram" && settings.telegram !== null) {
        results.push({
          channel,
          result: await deps.sendTelegram(
            { botToken: settings.telegram.botToken, chatId: settings.telegram.chatId },
            message,
          ),
        });
      }
    }
    const firstFailure = results.find((r) => !r.result.ok);
    const error =
      firstFailure === undefined || firstFailure.result.ok
        ? null
        : `${firstFailure.channel}:${firstFailure.result.code}`;
    const attempts = row.pushAttempts + 1;

    if (results.some((r) => r.result.ok)) {
      await record("sent", attempts, error);
      sent += 1;
    } else if (attempts >= PUSH_MAX_ATTEMPTS) {
      await record("failed", attempts, error);
      failed += 1;
    } else {
      await record("pending", attempts, error);
      retrying += 1;
    }
    if (error !== null) {
      deps.logger.warn(
        { companyId, notificationId: row.id, error, attempts },
        "push de notificación con error",
      );
    }
  }
  return { sent, failed, retrying };
}
