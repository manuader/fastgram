/**
 * Notificaciones del worker contra Postgres — sprint 7 (agente E):
 * detectores (posts, piloto, campañas, conexiones), deduplicación, push con
 * reintentos, preferencias apagadas y salud de la cola.
 *
 * Todo con RLS (`fastgram_app`). El push va contra dobles de `sendNtfy` /
 * `sendTelegram` que anotan: lo que se mide es qué se manda y cómo queda la
 * fila, no el HTTP (eso lo cubre `packages/adapters/src/notify`).
 */
import { randomUUID } from "node:crypto";
import {
  APP_ROLE,
  automations,
  autopilotRuns,
  connections,
  withCompany,
  type DbHandle,
  type NotificationBrandRow,
} from "@fastgram/db";
import type { PushMessage, PushResult } from "@fastgram/adapters";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createNotifier } from "../src/notifications/notifier.js";
import { createNotificationMonitor } from "../src/notifications/monitor.js";
import { readQueueProblems } from "../src/notifications/queue-health.js";
import type { BuildLogger } from "../src/content/build-handler.js";
import { openDb, seedCompany, seedPost } from "./helpers/fixtures.js";

const silent: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };
const TOPIC = "https://ntfy.sh/fg-worker-test";

let handle: DbHandle;

beforeAll(() => {
  handle = openDb();
});

afterAll(async () => {
  await handle?.close();
});

interface Harness {
  readonly sent: PushMessage[];
  nextResult: PushResult;
  settingsDoc: unknown;
  nowMs: number;
  readonly monitor: ReturnType<typeof createNotificationMonitor>;
}

function harness(companyIds: readonly string[], queueSchema = "pgboss"): Harness {
  const h = {
    sent: [] as PushMessage[],
    nextResult: { ok: true } as PushResult,
    settingsDoc: {
      version: 1,
      ntfy: { enabled: true, url: TOPIC },
    } as unknown,
    nowMs: Date.now(),
  } as Harness;
  const notifier = createNotifier({
    db: handle.db,
    appRole: APP_ROLE,
    logger: silent,
    settings: { read: async () => h.settingsDoc },
  });
  (h as { monitor: Harness["monitor"] }).monitor = createNotificationMonitor({
    db: handle.db,
    appRole: APP_ROLE,
    logger: silent,
    clock: { nowMs: () => h.nowMs, now: () => new Date(h.nowMs) },
    notifier,
    queueSchema,
    sendNtfy: async (_target, message) => {
      h.sent.push(message);
      return h.nextResult;
    },
    sendTelegram: async () => ({ ok: false, code: "unavailable" }),
    webBaseUrl: "http://localhost:3000",
    // La base de test es compartida: sólo las marcas de este caso.
    listBrands: async () =>
      companyIds.map<NotificationBrandRow>((companyId) => ({
        companyId,
        ownerUserId: companyId,
        name: "Acme",
        timezone: "UTC",
      })),
  });
  return h;
}

interface Row {
  readonly category: string;
  readonly title: string;
  readonly body: string;
  readonly link: string | null;
  readonly dedupeKey: string | null;
  readonly pushStatus: string;
  readonly pushAttempts: number;
  readonly pushError: string | null;
}

async function rowsOf(companyId: string): Promise<Row[]> {
  const rows = await handle.sql`
    select category, title, body, link, dedupe_key, push_status, push_attempts, push_error
      from notifications where company_id = ${companyId}::uuid order by created_at`;
  return rows.map((r) => ({
    category: String(r["category"]),
    title: String(r["title"]),
    body: String(r["body"]),
    link: (r["link"] as string | null) ?? null,
    dedupeKey: (r["dedupe_key"] as string | null) ?? null,
    pushStatus: String(r["push_status"]),
    pushAttempts: Number(r["push_attempts"]),
    pushError: (r["push_error"] as string | null) ?? null,
  }));
}

describe("detector de eventos", () => {
  it("un post fallido, uno publicado y un borrador de TikTok: un aviso cada uno, una sola vez", async () => {
    const companyId = await seedCompany(handle);
    const failed = await seedPost(handle, companyId, { status: "FAILED" });
    await seedPost(handle, companyId, { status: "POSTED", platform: "instagram" });
    const inbox = await seedPost(handle, companyId, { status: "IN_USER_INBOX" });
    // Uno agendado no avisa nada.
    await seedPost(handle, companyId, { status: "SCHEDULED" });

    const h = harness([companyId]);
    await h.monitor.events();
    await h.monitor.events();

    const rows = await rowsOf(companyId);
    expect(rows.map((r) => r.category).sort()).toEqual([
      "post_failed",
      "post_published",
      "tiktok_draft_ready",
    ]);
    expect(rows.find((r) => r.category === "post_failed")?.dedupeKey).toBe(
      `post:FAILED:${failed.postId}`,
    );
    expect(rows.find((r) => r.category === "tiktok_draft_ready")?.dedupeKey).toBe(
      `post:IN_USER_INBOX:${inbox.postId}`,
    );

    // Push según los defaults: el publicado no sale por push, los otros dos sí,
    // y la segunda vuelta no los manda otra vez.
    const published = rows.find((r) => r.category === "post_published");
    expect(published?.pushStatus).toBe("skipped");
    expect(h.sent).toHaveLength(2);
    expect(h.sent.some((m) => m.title.startsWith("Post failed on TikTok"))).toBe(true);
    expect(h.sent.some((m) => m.title.startsWith("TikTok draft ready"))).toBe(true);
    expect(h.sent.every((m) => m.clickUrl === "http://localhost:3000/home")).toBe(true);
    for (const r of rows.filter((x) => x.category !== "post_published")) {
      expect(r.pushStatus).toBe("sent");
      expect(r.pushAttempts).toBe(1);
    }
  });

  it("piloto con rechazos y campaña en REVIEW", async () => {
    const companyId = await seedCompany(handle);
    const automationId = await withCompany(
      handle.db,
      companyId,
      async (tx) => {
        await tx.insert(autopilotRuns).values({
          companyId,
          lastRunAt: new Date(),
          outcome: "ran",
          queueTarget: 5,
          queued: 3,
          approved: 1,
          rejected: 2,
          held: 0,
        });
        const [a] = await tx
          .insert(automations)
          .values({
            companyId,
            name: "Otoño",
            status: "REVIEW",
            perAccountPerDay: 1,
            durationWeeks: 1,
            startDateUtc: new Date(),
            timezone: "UTC",
          })
          .returning({ id: automations.id });
        return a?.id ?? "";
      },
      { role: APP_ROLE },
    );
    const h = harness([companyId]);
    await h.monitor.events();
    const rows = await rowsOf(companyId);
    expect(rows.find((r) => r.category === "autopilot_rejected")?.title).toBe(
      "Autopilot rejected 2 pieces",
    );
    expect(rows.find((r) => r.category === "campaign_ready")).toMatchObject({
      link: `/automations/${automationId}`,
      dedupeKey: `campaign:REVIEW:${automationId}`,
    });
  });

  it("una categoría apagada en los dos canales no escribe nada", async () => {
    const companyId = await seedCompany(handle);
    await seedPost(handle, companyId, { status: "FAILED" });
    const h = harness([companyId]);
    h.settingsDoc = {
      version: 1,
      categories: { post_failed: { inApp: false, push: false } },
    };
    await h.monitor.events();
    expect(await rowsOf(companyId)).toHaveLength(0);
  });

  it("un archivo de preferencias roto: defaults sin canales (campana sí, push no)", async () => {
    const companyId = await seedCompany(handle);
    await seedPost(handle, companyId, { status: "FAILED" });
    const h = harness([companyId]);
    h.settingsDoc = { version: 1, telegram: "roto" };
    await h.monitor.events();
    const rows = await rowsOf(companyId);
    expect(h.sent).toHaveLength(0);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pushStatus).toBe("skipped");
  });
});

describe("push: reintentos", () => {
  it("falla → pending con espera; al agotar los intentos → failed con código estable", async () => {
    const companyId = await seedCompany(handle);
    await seedPost(handle, companyId, { status: "FAILED" });
    const h = harness([companyId]);
    h.nextResult = { ok: false, code: "rate_limited", status: 429 };

    await h.monitor.events();
    let [row] = await rowsOf(companyId);
    expect(row).toMatchObject({
      pushStatus: "pending",
      pushAttempts: 1,
      pushError: "ntfy:rate_limited",
    });

    // Dentro de la espera no se reintenta.
    await h.monitor.events();
    expect(h.sent).toHaveLength(1);

    // Avanzar el reloj más allá de cada espera (1, 2, 4, 8 min).
    for (let i = 0; i < 4; i += 1) {
      h.nowMs += 20 * 60_000;
      await h.monitor.events();
    }
    [row] = await rowsOf(companyId);
    expect(row).toMatchObject({ pushStatus: "failed", pushAttempts: 5 });
    expect(h.sent).toHaveLength(5);
  });
});

describe("conexiones", () => {
  it("LinkedIn a 3 días de los 60 y una Instagram revocada", async () => {
    const companyId = await seedCompany(handle);
    const now = Date.now();
    await withCompany(
      handle.db,
      companyId,
      async (tx) => {
        await tx.insert(connections).values({
          companyId,
          platform: "linkedin",
          platformUserId: `li-${randomUUID()}`,
          platformUsername: "acme",
          tokenIssuedAt: new Date(now - 57 * 86_400_000),
        });
        await tx.insert(connections).values({
          companyId,
          platform: "instagram",
          platformUserId: `ig-${randomUUID()}`,
          platformUsername: "acme_ig",
          status: "revoked",
        });
      },
      { role: APP_ROLE },
    );
    const h = harness([companyId]);
    await h.monitor.slow();
    await h.monitor.slow();
    const rows = await rowsOf(companyId);
    expect(rows.map((r) => r.category).sort()).toEqual([
      "connection_expired",
      "connection_expiring",
    ]);
    expect(rows.find((r) => r.category === "connection_expiring")?.body).toContain(
      "LinkedIn connections last 60 days",
    );
    expect(rows.find((r) => r.category === "connection_expired")?.link).toBe(
      "/settings/connections",
    );
  });
});

describe("salud de la cola", () => {
  const SCHEMA = "fg_notif_queue_test";

  beforeAll(async () => {
    // Una tabla con las columnas de `pgboss.job` que la consulta usa. La base
    // de test del worker no tiene el esquema de pg-boss; la consulta real se
    // verificó aparte contra la base de desarrollo (ver el reporte).
    await handle.sql.unsafe(`
      drop schema if exists ${SCHEMA} cascade;
      create schema ${SCHEMA};
      create table ${SCHEMA}.job (
        id uuid primary key default gen_random_uuid(),
        name text not null,
        state text not null,
        start_after timestamptz not null default now(),
        started_on timestamptz,
        expire_in interval not null default '15 minutes',
        completed_on timestamptz
      );
      grant usage on schema ${SCHEMA} to fastgram_app;
      grant select on ${SCHEMA}.job to fastgram_app;
      insert into ${SCHEMA}.job (name, state, start_after) values
        ('content-build', 'created', now() - interval '40 minutes'),
        ('content-build', 'created', now() - interval '20 minutes'),
        ('content-build', 'created', now() - interval '2 minutes'),
        ('__pgboss__send-it', 'created', now() - interval '2 hours');
      insert into ${SCHEMA}.job (name, state, started_on, expire_in) values
        ('media-import', 'active', now() - interval '50 minutes', '15 minutes'),
        ('media-import', 'active', now() - interval '20 minutes', '15 minutes');
      insert into ${SCHEMA}.job (name, state, completed_on) values
        ('publishing', 'failed', now() - interval '3 minutes'),
        ('publishing', 'failed', now() - interval '3 days');
    `);
  });

  afterAll(async () => {
    await handle.sql.unsafe(`drop schema if exists ${SCHEMA} cascade`);
  });

  it("lee atascados, colgados y dead-letter, sin las colas internas", async () => {
    const problems = await readQueueProblems(
      { db: handle.db, appRole: APP_ROLE, queueSchema: SCHEMA },
      Date.now(),
    );
    const byKind = Object.fromEntries(
      problems.map((p) => [`${p.kind}:${p.queue}`, p.count]),
    );
    expect(byKind).toEqual({
      "waiting:content-build": 2,
      "active:media-import": 1,
      "failed:publishing": 1,
    });
  });

  it("avisa a la marca más vieja del dueño, una vez por cubo", async () => {
    const companyId = await seedCompany(handle);
    const h = harness([companyId], SCHEMA);
    await h.monitor.queue();
    await h.monitor.queue();
    const rows = (await rowsOf(companyId)).filter((r) => r.category.startsWith("queue_"));
    expect(rows.map((r) => r.title).sort()).toEqual([
      "1 job(s) failed for good in publishing",
      "1 job(s) stuck running in media-import",
      "2 job(s) waiting in content-build",
    ]);
  });

  it("un esquema con nombre inválido no llega a la consulta", async () => {
    await expect(
      readQueueProblems(
        { db: handle.db, appRole: APP_ROLE, queueSchema: 'x"; drop table y; --' },
        Date.now(),
      ),
    ).rejects.toThrow(/inválido/);
  });
});
