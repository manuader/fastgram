/**
 * Escribir un aviso — `P5-NOTIF-001/002`.
 *
 * Un borrador de `core` (`describeNotification`) + las preferencias de la
 * instalación → una fila en `notifications` (campana y/o outbox del push).
 *
 * ## `notify(...)`: una línea desde cualquier handler
 *
 * {@link notify} es un punto de entrada **de módulo** para que un handler
 * ajeno (publicación, piloto, campañas) pueda avisar algo con una línea, sin
 * cambiar sus dependencias. `main.ts` lo configura con
 * {@link configureNotifications}; sin configurar (tests) no hace nada. Nunca
 * lanza: un aviso que no se pudo escribir se loguea y el handler sigue.
 *
 * Hoy **ningún handler lo llama**: los avisos de posts, piloto y campañas los
 * produce el detector (`detectors.ts`) mirando la base, así llegan también
 * los que produce la API (marcar publicado a mano, vencimientos de
 * `AWAITING_RECONNECT`) y nadie tuvo que tocar los handlers de publicación
 * mientras otro agente los editaba. Queda para lo que no deja rastro en la
 * base.
 *
 * Abre su propia transacción, **después** de la del handler: dentro de la
 * transacción del handler, un fallo del INSERT abortaría la transacción
 * entera y con ella el trabajo real.
 */
import {
  categoryPreference,
  describeNotification,
  parseNotificationSettings,
  shouldPush,
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationDraft,
  type NotificationEvent,
  type NotificationSettings,
} from "@fastgram/core";
import { insertNotification, withCompany, type Database } from "@fastgram/db";

import type { BuildLogger } from "../content/build-handler.js";

export interface SettingsSource {
  read(): Promise<unknown>;
}

export interface NotifierDeps {
  readonly db: Database;
  readonly appRole?: string | undefined;
  readonly logger: BuildLogger;
  readonly settings: SettingsSource;
}

export interface Notifier {
  /** Las preferencias vigentes. Un archivo ilegible = defaults **sin canales**. */
  settings(): Promise<NotificationSettings>;
  /** `true` si se escribió una fila nueva (no repetida, no apagada). */
  write(
    companyId: string,
    draft: NotificationDraft,
    settings?: NotificationSettings,
  ): Promise<boolean>;
}

export function createNotifier(deps: NotifierDeps): Notifier {
  let warnedUnreadable = false;

  async function settings(): Promise<NotificationSettings> {
    try {
      const parsed = parseNotificationSettings(await deps.settings.read());
      if (parsed.ok) {
        warnedUnreadable = false;
        return parsed.settings;
      }
      if (!warnedUnreadable) {
        deps.logger.warn(
          { reason: parsed.reason },
          "notifications.json con forma inesperada: se usan los defaults sin canales",
        );
        warnedUnreadable = true;
      }
    } catch (error: unknown) {
      if (!warnedUnreadable) {
        deps.logger.warn(
          { err: error instanceof Error ? error.name : "unknown" },
          "no se pudo leer notifications.json: se usan los defaults sin canales",
        );
        warnedUnreadable = true;
      }
    }
    return DEFAULT_NOTIFICATION_SETTINGS;
  }

  async function write(
    companyId: string,
    draft: NotificationDraft,
    current?: NotificationSettings,
  ): Promise<boolean> {
    const s = current ?? (await settings());
    const inApp = categoryPreference(s, draft.category).inApp;
    const push = shouldPush(s, draft.category);
    if (!inApp && !push) return false;
    const out = await withCompany(
      deps.db,
      companyId,
      (tx) =>
        insertNotification(
          tx,
          { companyId },
          {
            category: draft.category,
            severity: draft.severity,
            title: draft.title,
            body: draft.body,
            link: draft.link,
            dedupeKey: draft.dedupeKey,
            inApp,
            pushStatus: push ? "pending" : "skipped",
          },
        ),
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );
    return out.created;
  }

  return { settings, write };
}

/* ------------------------------------------------------------------------ *
 * El punto de entrada de una línea
 * ------------------------------------------------------------------------ */

let configured: { notifier: Notifier; logger: BuildLogger } | null = null;

export function configureNotifications(
  notifier: Notifier | null,
  logger?: BuildLogger,
): void {
  configured = notifier === null || logger === undefined ? null : { notifier, logger };
}

/**
 * Avisa un evento de una marca. **Nunca lanza.** Sin configurar, no hace
 * nada. Ejemplo, en un handler:
 *
 *     void notify(companyId, { kind: "campaign", brand, automationId, name, status: "REVIEW" });
 */
export async function notify(companyId: string, event: NotificationEvent): Promise<void> {
  const current = configured;
  if (current === null) return;
  try {
    await current.notifier.write(companyId, describeNotification(event));
  } catch (error: unknown) {
    current.logger.warn(
      {
        companyId,
        kind: event.kind,
        err: error instanceof Error ? error.message : "unknown",
      },
      "no se pudo escribir la notificación",
    );
  }
}
