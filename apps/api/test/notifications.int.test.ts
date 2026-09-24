/**
 * Sprint 7 — avisos y confiabilidad (agente E), contra Postgres real y con
 * `SET LOCAL ROLE fastgram_app`:
 *
 *  - `P1-TENANT-005`: borrar una marca apaga posts agendados, slots, piloto
 *    y campañas (antes quedaban vivos: confirmado con este mismo test sin el
 *    arreglo — ver el reporte del agente).
 *  - `P2-MEDIA-004` / `P1-STORAGE-006`: `409 media_in_use` y borrado
 *    best-effort del objeto del bucket.
 *  - `P5-NOTIF-001`: la campana de todas las marcas del dueño, leídos, y un
 *    aviso de otro dueño es 404.
 *  - El banner de conexiones y las preferencias (secretos enmascarados, envío
 *    de prueba contra un ntfy local).
 *
 * En los negativos, la aserción negativa va primero (trampa 35).
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MemoryStorage, FixedClock } from "@fastgram/adapters";
import {
  APP_ROLE,
  automations,
  brandStrategies,
  companies,
  connections,
  contents,
  insertNotification,
  media,
  plannedSlots,
  posts,
  users,
  withCompany,
  withoutCompany,
} from "@fastgram/db";
import type { Storage } from "@fastgram/ports";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

const BOT_TOKEN = "123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw";

let api: ApiHarness;
let home: string;
let previousHome: string | undefined;
let ntfy: Server;
let ntfyUrl: string;
const received: Array<{ headers: IncomingMessage["headers"]; body: string }> = [];

/** Un storage que falla al borrar, para `ERR-F05`. */
let failDeletes = false;
const memory = new MemoryStorage(new FixedClock("2026-09-24T12:00:00.000Z"));
const storage: Storage = new Proxy(memory, {
  get(target, prop, receiver) {
    if (prop === "delete") {
      return async (key: string) => {
        if (failDeletes) throw new Error("bucket caído");
        return target.delete(key);
      };
    }
    const value: unknown = Reflect.get(target, prop, receiver);
    return typeof value === "function" ? (value as () => unknown).bind(target) : value;
  },
});

beforeAll(async () => {
  previousHome = process.env["FASTGRAM_HOME"];
  home = await mkdtemp(join(tmpdir(), "fg-notif-int-"));
  // `registerV1Routes` arma el archivo de preferencias desde el entorno.
  process.env["FASTGRAM_HOME"] = home;

  ntfy = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString("utf8");
    });
    req.on("end", () => {
      received.push({ headers: req.headers, body });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => ntfy.listen(0, "127.0.0.1", resolve));
  ntfyUrl = `http://127.0.0.1:${String((ntfy.address() as AddressInfo).port)}/fg-test-topic`;

  api = await startApi({ mode: "personal", now: "2026-09-24T12:00:00.000Z", storage });
}, 180_000);

afterAll(async () => {
  await api?.close();
  await new Promise<void>((resolve) => ntfy?.close(() => resolve()));
  if (previousHome === undefined) delete process.env["FASTGRAM_HOME"];
  else process.env["FASTGRAM_HOME"] = previousHome;
});

/* ------------------------------------------------------------------------ *
 * P1-TENANT-005 — borrar una marca apaga lo que tenía en marcha
 * ------------------------------------------------------------------------ */

describe("DELETE /workspaces/:id apaga la actividad de la marca", () => {
  it("cancela posts agendados, borra slots, apaga el piloto y cancela campañas", async () => {
    const b = api.data.b;
    const inboxPostId = await withCompany(
      api.handle.db,
      b.companyId,
      async (tx) => {
        await tx.insert(brandStrategies).values({
          companyId: b.companyId,
          language: "es",
          autonomy: "autopilot",
          jitterMinutes: 0,
          brandGapMinutes: 0,
        });
        await tx.insert(plannedSlots).values({
          companyId: b.companyId,
          contentId: b.contentId,
          network: "instagram",
          scheduledAtUtc: new Date("2026-10-02T12:00:00.000Z"),
        });
        await tx.insert(automations).values({
          companyId: b.companyId,
          name: "campaña viva",
          status: "ACTIVE",
          perAccountPerDay: 1,
          durationWeeks: 1,
          startDateUtc: new Date("2026-09-25T00:00:00.000Z"),
          timezone: "UTC",
        });
        // Ya en TikTok: no se toca (decir "cancelado" sería mentir).
        const [inbox] = await tx
          .insert(posts)
          .values({
            companyId: b.companyId,
            contentId: b.contentId,
            platform: "tiktok",
            accountType: "oauth",
            connectionId: b.connectionId,
            scheduledAtUtc: new Date("2026-09-20T12:00:00.000Z"),
            status: "IN_USER_INBOX",
          })
          .returning({ id: posts.id });
        return inbox?.id ?? "";
      },
      { role: APP_ROLE },
    );

    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/workspaces/${b.companyId}`,
    });
    expect(res.status).toBe(204);

    const [post] = await api.handle
      .sql`select status from posts where id = ${b.postId}::uuid`;
    expect(post).toMatchObject({ status: "CANCELLED" });
    const [inbox] = await api.handle
      .sql`select status from posts where id = ${inboxPostId}::uuid`;
    expect(inbox).toMatchObject({ status: "IN_USER_INBOX" });
    const slots = await api.handle.sql`
      select id from planned_slots where company_id = ${b.companyId}::uuid and status = 'planned'`;
    expect(slots).toHaveLength(0);
    const [strategy] = await api.handle.sql`
      select autonomy from brand_strategies where company_id = ${b.companyId}::uuid`;
    expect(strategy).toMatchObject({ autonomy: "manual" });
    const [campaign] = await api.handle.sql`
      select status, cancelled_at from automations where company_id = ${b.companyId}::uuid`;
    expect(campaign).toMatchObject({ status: "CANCELLED" });
    expect((campaign as { cancelled_at: Date | null }).cancelled_at).not.toBeNull();

    // La marca de la key no se tocó.
    const [postA] = await api.handle.sql`
      select status from posts where id = ${api.data.a.postId}::uuid`;
    expect(postA).toMatchObject({ status: "SCHEDULED" });
  });
});

/* ------------------------------------------------------------------------ *
 * P2-MEDIA-004 / P1-STORAGE-006
 * ------------------------------------------------------------------------ */

async function seedMedia(name: string): Promise<{ id: string; key: string }> {
  const companyId = api.data.a.companyId;
  const key = `media/${companyId}/${name}-${randomUUID()}.png`;
  await memory.put({ key, body: new Uint8Array([1, 2, 3]), contentType: "image/png" });
  const id = await withCompany(
    api.handle.db,
    companyId,
    async (tx) => {
      const [row] = await tx
        .insert(media)
        .values({
          companyId,
          mediaType: "image",
          filename: `${name}.png`,
          r2Url: `https://cdn.example.test/${key}`,
          storageKey: key,
          sizeMb: 0.1,
          origin: "manual_upload",
          status: "ready",
        })
        .returning({ id: media.mediaId });
      return row?.id ?? "";
    },
    { role: APP_ROLE },
  );
  return { id, key };
}

describe("DELETE /media/:id — en uso y storage", () => {
  it("409 media_in_use si una pieza viva la usa; la fila y el objeto quedan", async () => {
    const m = await seedMedia("en-uso");
    await withCompany(
      api.handle.db,
      api.data.a.companyId,
      (tx) =>
        tx.insert(contents).values({
          companyId: api.data.a.companyId,
          type: "wall-of-text",
          status: "CREATED",
          buildPayload: { video: { mediaId: m.id, url: "x" } },
        }),
      { role: APP_ROLE },
    );
    const res = await api.request({ method: "DELETE", path: `/api/v1/media/${m.id}` });
    expect(res.status).toBe(409);
    expect(errorOf(res)).toMatchObject({ code: "media_in_use" });
    const [row] = await api.handle
      .sql`select deleted_at from media where media_id = ${m.id}::uuid`;
    expect((row as { deleted_at: Date | null }).deleted_at).toBeNull();
    expect(await memory.head(m.key)).not.toBeNull();
  });

  it("una pieza BORRADA que la usaba no cuenta: 204, fila borrada y objeto borrado", async () => {
    const m = await seedMedia("libre");
    await withCompany(
      api.handle.db,
      api.data.a.companyId,
      (tx) =>
        tx.insert(contents).values({
          companyId: api.data.a.companyId,
          type: "wall-of-text",
          status: "CREATED",
          buildPayload: { video: { mediaId: m.id } },
          deletedAt: new Date(),
        }),
      { role: APP_ROLE },
    );
    const res = await api.request({ method: "DELETE", path: `/api/v1/media/${m.id}` });
    expect(res.status).toBe(204);
    const [row] = await api.handle
      .sql`select deleted_at from media where media_id = ${m.id}::uuid`;
    expect((row as { deleted_at: Date | null }).deleted_at).not.toBeNull();
    expect(await memory.head(m.key)).toBeNull();
  });

  it("si el bucket falla, el borrado de la fila igual se hace (ERR-F05)", async () => {
    const m = await seedMedia("bucket-caido");
    failDeletes = true;
    try {
      const res = await api.request({ method: "DELETE", path: `/api/v1/media/${m.id}` });
      expect(res.status).toBe(204);
    } finally {
      failDeletes = false;
    }
    const [row] = await api.handle
      .sql`select deleted_at from media where media_id = ${m.id}::uuid`;
    expect((row as { deleted_at: Date | null }).deleted_at).not.toBeNull();
    // Huérfano aceptado: el objeto sigue ahí.
    expect(await memory.head(m.key)).not.toBeNull();
  });

  it("ajeno, inexistente o no-uuid siguen siendo 204 (no revela existencia)", async () => {
    for (const id of [api.data.unknownId, "no-es-uuid"]) {
      const res = await api.request({ method: "DELETE", path: `/api/v1/media/${id}` });
      expect(res.status).toBe(204);
    }
  });
});

/* ------------------------------------------------------------------------ *
 * P5-NOTIF-001 — la campana
 * ------------------------------------------------------------------------ */

describe("la campana", () => {
  let foreignNotificationId = "";
  let idA = "";

  beforeAll(async () => {
    const note = (title: string, dedupeKey: string | null, inApp = true) => ({
      category: "post_failed",
      severity: "error" as const,
      title,
      body: "cuerpo",
      link: "/home",
      dedupeKey,
      inApp,
      pushStatus: "skipped" as const,
    });
    idA =
      (
        await withCompany(
          api.handle.db,
          api.data.a.companyId,
          async (tx) => {
            const first = await insertNotification(
              tx,
              { companyId: api.data.a.companyId },
              note("de a", "k1"),
            );
            // Misma clave: no se duplica.
            const again = await insertNotification(
              tx,
              { companyId: api.data.a.companyId },
              note("de a otra vez", "k1"),
            );
            expect(again.created).toBe(false);
            // Sólo push: no aparece en la campana.
            await insertNotification(
              tx,
              { companyId: api.data.a.companyId },
              note("sólo push", null, false),
            );
            return first;
          },
          { role: APP_ROLE },
        )
      ).id ?? "";

    // Una marca de OTRO dueño, con su aviso.
    foreignNotificationId = await withoutCompany(api.handle.db, async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          externalIdentityId: `ext-${randomUUID()}`,
          email: `otro-${randomUUID()}@example.test`,
          fullName: "Otro dueño",
          timezone: "UTC",
        })
        .returning({ id: users.id });
      const [company] = await tx
        .insert(companies)
        .values({
          name: "ajena",
          ownerUserId: user?.id ?? "",
          status: "active",
          planId: "growth",
          billingAnchorDay: 1,
          timezone: "UTC",
        })
        .returning({ id: companies.id });
      return company?.id ?? "";
    }).then((foreignId) =>
      withCompany(
        api.handle.db,
        foreignId,
        async (tx) =>
          (await insertNotification(tx, { companyId: foreignId }, note("ajena", null)))
            .id ?? "",
        { role: APP_ROLE },
      ),
    );
  });

  it("lista los avisos in-app de las marcas del dueño, sin los ajenos", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/notifications" });
    expect(res.status).toBe(200);
    const body = dataOf(res) as {
      items: Array<Record<string, unknown>>;
      unreadCount: number;
    };
    const ids = body.items.map((i) => i["id"]);
    expect(ids).not.toContain(foreignNotificationId);
    expect(body.items.map((i) => i["title"])).not.toContain("sólo push");
    expect(body.items.map((i) => i["title"])).toContain("de a");
    expect(body.items.find((i) => i["id"] === idA)).toMatchObject({
      workspaceId: api.data.a.companyId,
      workspaceName: "acme",
      category: "post_failed",
      read: false,
    });
    expect(body.unreadCount).toBeGreaterThanOrEqual(1);
  });

  it("marcar leído un aviso de otro dueño es 404; el propio es 204", async () => {
    const foreign = await api.request({
      method: "POST",
      path: `/api/v1/notifications/${foreignNotificationId}/read`,
    });
    expect(foreign.status).toBe(404);
    const [still] = await api.handle.sql`
      select read_at from notifications where id = ${foreignNotificationId}::uuid`;
    expect((still as { read_at: Date | null }).read_at).toBeNull();

    const own = await api.request({
      method: "POST",
      path: `/api/v1/notifications/${idA}/read`,
    });
    expect(own.status).toBe(204);
  });

  it("read-all deja el contador en 0", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/notifications/read-all",
      body: {},
    });
    expect(res.status).toBe(200);
    const list = await api.request({ method: "GET", path: "/api/v1/notifications" });
    expect((dataOf(list) as { unreadCount: number }).unreadCount).toBe(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Banner de conexiones
 * ------------------------------------------------------------------------ */

describe("GET /notifications/connection-alerts", () => {
  it("vencidas y por vencer (≤7 días), las vencidas primero", async () => {
    const companyId = api.data.a.companyId;
    await withCompany(
      api.handle.db,
      companyId,
      async (tx) => {
        await tx.insert(connections).values({
          companyId,
          platform: "linkedin",
          platformUserId: `li-${randomUUID()}`,
          platformUsername: "acme-li",
          publishable: true,
          // Sin tokenExpiry: 60 días desde la emisión → vence en 3 días.
          tokenIssuedAt: new Date("2026-07-29T12:00:00.000Z"),
        });
        await tx.insert(connections).values({
          companyId,
          platform: "instagram",
          platformUserId: `ig-${randomUUID()}`,
          platformUsername: "acme-ig",
          publishable: true,
          status: "expired",
          statusReason: "token_revoked",
        });
      },
      { role: APP_ROLE },
    );
    const res = await api.request({
      method: "GET",
      path: "/api/v1/notifications/connection-alerts",
    });
    expect(res.status).toBe(200);
    const alerts = (dataOf(res) as { alerts: Array<Record<string, unknown>> }).alerts;
    // La tiktok del fixture no vence: no aparece.
    expect(alerts.map((a) => a["platform"])).not.toContain("tiktok");
    expect(alerts.map((a) => [a["platform"], a["state"]])).toEqual([
      ["instagram", "expired"],
      ["linkedin", "expiring"],
    ]);
    expect(alerts[0]).toMatchObject({ reason: "token_revoked", deadline: null });
    expect(alerts[1]).toMatchObject({ deadline: "2026-09-27T12:00:00.000Z" });
  });
});

/* ------------------------------------------------------------------------ *
 * Preferencias y canales
 * ------------------------------------------------------------------------ */

describe("preferencias y canales", () => {
  it("sin archivo, los defaults", async () => {
    const res = await api.request({
      method: "GET",
      path: "/api/v1/notifications/settings",
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toMatchObject({
      ntfy: { configured: false },
      telegram: { configured: false },
      dailySummaryHour: 8,
    });
  });

  it("guarda con 0600 y nunca devuelve un secreto entero", async () => {
    const res = await api.request({
      method: "PUT",
      path: "/api/v1/notifications/settings",
      body: {
        ntfy: { url: ntfyUrl },
        telegram: { botToken: BOT_TOKEN, chatId: "424242" },
        categories: [{ category: "post_published", push: true }],
      },
    });
    expect(res.status).toBe(200);
    expect(res.raw).not.toContain(BOT_TOKEN);
    expect(res.raw).not.toContain("fg-test-topic");
    expect(dataOf(res)).toMatchObject({
      ntfy: { configured: true, enabled: true },
      telegram: { configured: true, chatId: "424242", botTokenHint: "…Dsaw" },
    });
    const path = join(home, "notifications.json");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).toContain(BOT_TOKEN);
  });

  it("un valor inválido es 400 con el campo, y no pisa lo guardado", async () => {
    const res = await api.request({
      method: "PUT",
      path: "/api/v1/notifications/settings",
      body: { telegram: { chatId: "no válido" } },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toMatchObject({ field: "telegram.chatId" });
    expect(await readFile(join(home, "notifications.json"), "utf8")).toContain("424242");
  });

  it("el envío de prueba llega al topic de ntfy", async () => {
    received.length = 0;
    const res = await api.request({
      method: "POST",
      path: "/api/v1/notifications/test",
      body: { channel: "ntfy" },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)).toEqual({ ok: true, channel: "ntfy", error: null });
    expect(received).toHaveLength(1);
    expect(received[0]?.headers["title"]).toBe("FastGram test notification");
    expect(received[0]?.body).toContain("notifications reach you here");
  });

  it("borrar el canal lo deja sin configurar y la prueba dice not_configured", async () => {
    await api.request({
      method: "PUT",
      path: "/api/v1/notifications/settings",
      body: { ntfy: null },
    });
    const res = await api.request({
      method: "POST",
      path: "/api/v1/notifications/test",
      body: { channel: "ntfy" },
    });
    expect(dataOf(res)).toEqual({ ok: false, channel: "ntfy", error: "not_configured" });
  });
});
