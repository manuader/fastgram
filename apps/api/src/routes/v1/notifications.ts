/**
 * Notificaciones — `P5-NOTIF-001…004`, PRD §13, `P3-OAUTH-005/011` (sprint 7).
 * El contrato está en `@fastgram/contracts` (`resources/notifications.ts`).
 *
 * ## Quién escribe y quién lee
 *
 * Los avisos los escribe **el worker** (`apps/worker/src/notifications/`):
 * detecta los hechos (posts publicados/fallidos, borradores de TikTok,
 * conexiones, piloto, campañas, resumen diario, cola) y también despacha el
 * push. Esta ruta sólo lee la campana, marca leídos, calcula el banner de
 * conexiones **en vivo** (no desde los avisos: el banner tiene que ser
 * verdad aunque el worker esté caído) y administra las preferencias.
 *
 * ## "Todas las marcas"
 *
 * La campana y el banner son globales en el modo personal: las marcas del
 * dueño de la credencial (`workspaceDirectory`, sin tenant, sólo para
 * listarlas) y los datos de cada una con **su** scope (`runScoped`). Mismo
 * patrón que `GET /autopilot/digest?brands=all`. Fuera del modo personal,
 * "todas" es la de la request.
 *
 * ## Decisiones que el PRD no cubre
 *
 * - Las preferencias y los canales son **de la instalación** (un dueño,
 *   D-06), en `~/.fastgram/notifications.json` `0600`, no por marca. Mismo
 *   criterio y misma advertencia que `models.ts`: abierto a terceros, esto
 *   pasa a ser de un administrador.
 * - Ningún secreto vuelve por la API: el token del bot y el topic de ntfy
 *   salen enmascarados (`toPublicNotificationSettings`).
 * - El link del aviso de prueba (y de los push) apunta a `FASTGRAM_WEB_URL`
 *   (default `http://localhost:3000`) y **no** a `FASTGRAM_PUBLIC_URL`: el
 *   túnel expone la web sin login, y un push no debería invitar a abrirla por
 *   ahí.
 */
import {
  listNotificationsQuerySchema,
  markAllNotificationsReadRequestSchema,
  notificationCategorySchema,
  notificationSeveritySchema,
  testNotificationRequestSchema,
  updateNotificationSettingsRequestSchema,
  type AppNotification,
  type ConnectionAlert,
  type FastgramMode,
  type NotificationTestResult,
} from "@fastgram/contracts";
import {
  applyNotificationSettingsUpdate,
  assessConnectionHealth,
  parseNotificationSettings,
  serializeNotificationSettings,
  toPublicNotificationSettings,
  type NotificationSettings,
  type NotificationSettingsUpdate,
} from "@fastgram/core";
import {
  notificationSettingsFile,
  sendNtfy,
  sendTelegram,
  type PushMessage,
  type PushResult,
} from "@fastgram/adapters";
import {
  companyRepository,
  countUnreadNotifications,
  listConnectionsForHealth,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  withoutCompany,
  workspaceDirectory,
} from "@fastgram/db";
import type { FastifyRequest } from "fastify";
import { z } from "zod";

import { ownerOrFail, runScoped } from "../../auth/scope.js";
import { ApiRejection } from "../../http/errors.js";
import { data, notFound } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

/** Lo que la ruta necesita del archivo: `JsonFileDocument` lo cumple. */
export interface SettingsDocument {
  read(): Promise<unknown>;
  update<T>(
    fn: (current: unknown) => { readonly next?: unknown; readonly result: T },
  ): Promise<T>;
}

export interface NotificationRouteDeps {
  readonly settings: SettingsDocument;
  readonly sendNtfy: typeof sendNtfy;
  readonly sendTelegram: typeof sendTelegram;
  readonly webBaseUrl: string;
}

export function webBaseUrlFrom(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const raw = env["FASTGRAM_WEB_URL"]?.trim();
  return raw !== undefined && /^https?:\/\//u.test(raw)
    ? raw.replace(/\/+$/u, "")
    : "http://localhost:3000";
}

export function defaultNotificationRouteDeps(
  env: Readonly<Record<string, string | undefined>> = process.env,
): NotificationRouteDeps {
  return {
    settings: notificationSettingsFile(env),
    sendNtfy,
    sendTelegram,
    webBaseUrl: webBaseUrlFrom(env),
  };
}

const idParams = z.object({ id: z.string().uuid() });

interface Brand {
  readonly id: string;
  readonly name: string;
}

function homeCompanyOf(request: FastifyRequest): string {
  return request.auth.homeCompanyId ?? request.auth.companyId;
}

export function registerNotificationRoutes(
  app: ZodApp,
  deps: NotificationRouteDeps = defaultNotificationRouteDeps(),
): void {
  const { db, clock, appRole } = app.deps;
  const mode: FastgramMode = app.deps.mode ?? "standard";

  async function brandsFor(
    request: FastifyRequest,
    which: "current" | "all",
  ): Promise<Brand[]> {
    const companyId = request.auth.companyId;
    if (mode !== "personal" || which === "current") {
      const company = await runScoped(db, companyId, appRole, (tx) =>
        companyRepository.load(tx, { companyId }),
      );
      return [{ id: companyId, name: company?.name ?? "" }];
    }
    return withoutCompany(db, async (tx) => {
      const owner = await ownerOrFail(tx, homeCompanyOf(request));
      const all = await workspaceDirectory.list(tx, owner);
      return all.map((w) => ({ id: w.id, name: w.name }));
    });
  }

  async function readSettings(): Promise<NotificationSettings> {
    let raw: unknown;
    try {
      raw = await deps.settings.read();
    } catch {
      throw new ApiRejection(
        503,
        "service_unavailable",
        "Notification settings can't be read right now.",
      );
    }
    const parsed = parseNotificationSettings(raw);
    if (!parsed.ok) {
      // No se pisa: puede tener un token que el dueño no tiene en otro lado.
      throw new ApiRejection(
        503,
        "service_unavailable",
        "The notification settings file (~/.fastgram/notifications.json) has an unexpected shape. Fix or remove it.",
      );
    }
    return parsed.settings;
  }

  // ── GET /notifications ──
  app.get(
    "/notifications",
    { schema: { querystring: listNotificationsQuerySchema } },
    async (request) => {
      const { limit, unread, brands } = request.query;
      const items: AppNotification[] = [];
      let unreadCount = 0;
      for (const brand of await brandsFor(request, brands)) {
        const { rows, count } = await runScoped(db, brand.id, appRole, async (tx) => ({
          rows: await listNotifications(
            tx,
            { companyId: brand.id },
            { limit, unreadOnly: unread === "true" },
          ),
          count: await countUnreadNotifications(tx, { companyId: brand.id }),
        }));
        unreadCount += count;
        for (const row of rows) {
          const category = notificationCategorySchema.safeParse(row.category);
          const severity = notificationSeveritySchema.safeParse(row.severity);
          // Una categoría que este contrato no conoce (un worker más nuevo) no
          // rompe la campana: se saltea.
          if (!category.success || !severity.success) continue;
          items.push({
            id: row.id,
            workspaceId: brand.id,
            workspaceName: brand.name,
            category: category.data,
            severity: severity.data,
            title: row.title,
            body: row.body,
            link: row.link,
            read: row.readAt !== null,
            createdAt: row.createdAt.toISOString(),
          });
        }
      }
      items.sort((a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
      );
      return data({ items: items.slice(0, limit), unreadCount });
    },
  );

  // ── POST /notifications/:id/read ──
  app.post(
    "/notifications/:id/read",
    { schema: { params: idParams } },
    async (request, reply) => {
      const now = new Date(clock.nowMs());
      for (const brand of await brandsFor(request, "all")) {
        const found = await runScoped(db, brand.id, appRole, (tx) =>
          markNotificationRead(tx, { companyId: brand.id }, request.params.id, now),
        );
        if (found) return reply.status(204).send();
      }
      throw notFound("notification");
    },
  );

  // ── POST /notifications/read-all ──
  app.post(
    "/notifications/read-all",
    { schema: { body: markAllNotificationsReadRequestSchema.optional() } },
    async (request) => {
      const which = request.body?.brands ?? "all";
      const now = new Date(clock.nowMs());
      let updated = 0;
      for (const brand of await brandsFor(request, which)) {
        updated += await runScoped(db, brand.id, appRole, (tx) =>
          markAllNotificationsRead(tx, { companyId: brand.id }, now),
        );
      }
      return data({ updated });
    },
  );

  // ── GET /notifications/connection-alerts ──
  app.get("/notifications/connection-alerts", async (request) => {
    const nowMs = clock.nowMs();
    const alerts: ConnectionAlert[] = [];
    for (const brand of await brandsFor(request, "all")) {
      const rows = await runScoped(db, brand.id, appRole, (tx) =>
        listConnectionsForHealth(tx, { companyId: brand.id }),
      );
      for (const row of rows) {
        const health = assessConnectionHealth(row, nowMs);
        if (health.state === "ok") continue;
        alerts.push({
          workspaceId: brand.id,
          workspaceName: brand.name,
          connectionId: row.id,
          platform: row.platform,
          account: row.displayName ?? row.platformUsername,
          state: health.state,
          deadline: health.state === "expiring" ? health.deadline.toISOString() : null,
          reason: health.state === "expired" ? (row.statusReason ?? health.reason) : null,
        });
      }
    }
    // Las vencidas primero; después, la que vence antes.
    alerts.sort((a, b) =>
      a.state !== b.state
        ? a.state === "expired"
          ? -1
          : 1
        : (a.deadline ?? "").localeCompare(b.deadline ?? ""),
    );
    return data({ alerts });
  });

  // ── GET /notifications/settings ──
  app.get("/notifications/settings", async () =>
    data(toPublicNotificationSettings(await readSettings())),
  );

  // ── PUT /notifications/settings ──
  app.put(
    "/notifications/settings",
    { schema: { body: updateNotificationSettingsRequestSchema } },
    async (request) => {
      const body = request.body;
      const update: NotificationSettingsUpdate = body;
      type Outcome = ReturnType<typeof applyNotificationSettingsUpdate> | "unreadable";
      let outcome: Outcome;
      try {
        outcome = await deps.settings.update<Outcome>((current) => {
          const parsed = parseNotificationSettings(current);
          if (!parsed.ok) return { result: "unreadable" as const };
          const applied = applyNotificationSettingsUpdate(parsed.settings, update);
          return applied.ok
            ? { next: serializeNotificationSettings(applied.settings), result: applied }
            : { result: applied };
        });
      } catch {
        throw new ApiRejection(
          503,
          "service_unavailable",
          "Notification settings can't be saved right now.",
        );
      }
      if (outcome === "unreadable") {
        throw new ApiRejection(
          503,
          "service_unavailable",
          "The notification settings file (~/.fastgram/notifications.json) has an unexpected shape. Fix or remove it.",
        );
      }
      if (!outcome.ok) {
        throw new ApiRejection(400, "bad_request", outcome.message, {
          field: outcome.field,
        });
      }
      return data(toPublicNotificationSettings(outcome.settings));
    },
  );

  // ── POST /notifications/test ──
  app.post(
    "/notifications/test",
    { schema: { body: testNotificationRequestSchema } },
    async (request) => {
      const { channel } = request.body;
      const settings = await readSettings();
      const message: PushMessage = {
        title: "FastGram test notification",
        body: "If you can read this, notifications reach you here.",
        severity: "info",
        clickUrl: `${deps.webBaseUrl}/settings/notifications`,
      };
      let result: PushResult | null = null;
      if (channel === "ntfy" && settings.ntfy !== null) {
        result = await deps.sendNtfy(
          { url: settings.ntfy.url, token: settings.ntfy.token },
          message,
        );
      }
      if (channel === "telegram" && settings.telegram !== null) {
        result = await deps.sendTelegram(
          { botToken: settings.telegram.botToken, chatId: settings.telegram.chatId },
          message,
        );
      }
      const out: NotificationTestResult =
        result === null
          ? { ok: false, channel, error: "not_configured" }
          : result.ok
            ? { ok: true, channel, error: null }
            : { ok: false, channel, error: result.code };
      // Nunca el destino ni el token: sólo qué canal y cómo terminó.
      request.log.info({ channel, ok: out.ok, error: out.error }, "notification test");
      return data(out);
    },
  );
}
