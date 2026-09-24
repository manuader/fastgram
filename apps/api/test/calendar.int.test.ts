/**
 * Estrategia, auto-slot y calendario — `PU-BRAND-002`, `PU-CAL-001`,
 * `PU-CAL-002`. Contra Postgres real, en modo personal (dos marcas del mismo
 * dueño: `a` y `b` del fixture) y con el reloj del arnés en el lunes
 * 2026-09-21 12:00Z.
 *
 * El fixture ya trae, por marca, una conexión TikTok activa y un post de TikTok
 * `SCHEDULED` para el 2026-10-01 12:00Z sobre su contenido. Por eso el auto-slot
 * se prueba con **contenidos nuevos**: el del fixture ya tiene TikTok programado
 * y saldría `already_scheduled`.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JOB_QUEUES } from "@fastgram/core";
import {
  APP_ROLE,
  contents,
  plannedSlots,
  withCompany,
  withoutCompany,
} from "@fastgram/db";

import { convertPlannedSlot } from "../src/routes/v1/calendar.js";
import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

const HEADER = "x-fastgram-workspace";
const MIN = 60_000;
const NOW = Date.parse("2026-09-21T12:00:00.000Z");

let api: ApiHarness;

beforeAll(async () => {
  api = await startApi({ mode: "personal" });
}, 180_000);

afterAll(async () => {
  await api?.close();
});

beforeEach(() => {
  api.queue.reset();
});

async function newContent(companyId: string): Promise<string> {
  return withoutCompany(api.handle.db, async (tx) => {
    const [row] = await tx
      .insert(contents)
      .values({ companyId, type: "slideshow", status: "CREATED" })
      .returning({ id: contents.id });
    if (row === undefined) throw new Error("no se creó el contenido");
    return row.id;
  });
}

const days = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };

function strategyBody(over: Record<string, unknown> = {}) {
  return {
    networks: [
      { network: "instagram", enabled: true, perDay: 1, dailyCap: 3 },
      { network: "tiktok", enabled: false, perDay: 1, dailyCap: 3 },
    ],
    windows: { ...days, mon: ["13:00"], tue: ["13:00"] },
    timezone: "UTC",
    language: "es",
    autonomy: "manual",
    jitterMinutes: 0,
    brandGapMinutes: 10,
    formatMix: { slideshow: 60, "wall-of-text": 40 },
    ...over,
  };
}

const putStrategy = (body: unknown, brand?: string) =>
  api.request({
    method: "PUT",
    path: "/api/v1/strategy",
    body,
    ...(brand === undefined ? {} : { headers: { [HEADER]: brand } }),
  });

const autoschedule = (contentId: string, brand?: string, body: unknown = {}) =>
  api.request({
    method: "POST",
    path: `/api/v1/content/${contentId}/autoschedule`,
    body,
    ...(brand === undefined ? {} : { headers: { [HEADER]: brand } }),
  });

describe("GET/PUT /strategy", () => {
  it("sin guardar, devuelve la por defecto con los topes anti-bot", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/strategy" });
    expect(res.status).toBe(200);
    const s = dataOf(res);
    expect(s["isDefault"]).toBe(true);
    expect(s["timezone"]).toBe("UTC");
    expect(s["jitterMinutes"]).toBe(7);
    expect(s["brandGapMinutes"]).toBe(10);
    const networks = s["networks"] as {
      network: string;
      enabled: boolean;
      dailyCap: number;
    }[];
    expect(networks.filter((n) => n.enabled).map((n) => n.network)).toEqual([
      "instagram",
      "tiktok",
    ]);
    expect(networks.every((n) => n.dailyCap === 3)).toBe(true);
  });

  it("PUT guarda, normaliza las ventanas y cambia la zona de la marca", async () => {
    const res = await putStrategy(
      strategyBody({
        timezone: "America/Argentina/Buenos_Aires",
        windows: { ...days, mon: ["19:00", "09:00", "09:00"] },
        autonomy: "autopilot",
      }),
    );
    expect(res.status).toBe(200);
    const s = dataOf(res);
    expect(s["isDefault"]).toBe(false);
    expect((s["windows"] as Record<string, string[]>)["mon"]).toEqual(["09:00", "19:00"]);

    const again = dataOf(await api.request({ method: "GET", path: "/api/v1/strategy" }));
    expect(again["autonomy"]).toBe("autopilot");
    expect(again["timezone"]).toBe("America/Argentina/Buenos_Aires");

    // La otra marca, intacta.
    const other = dataOf(
      await api.request({
        method: "GET",
        path: "/api/v1/strategy",
        headers: { [HEADER]: api.data.b.companyId },
      }),
    );
    expect(other["isDefault"]).toBe(true);
  });

  it("rechaza lo que el contrato no admite", async () => {
    const tooMany = await putStrategy(
      strategyBody({
        networks: [{ network: "instagram", enabled: true, perDay: 4, dailyCap: 3 }],
      }),
    );
    expect(tooMany.status).toBe(400);
    const badZone = await putStrategy(strategyBody({ timezone: "Mars/Olympus" }));
    expect(badZone.status).toBe(400);
    const badTime = await putStrategy(
      strategyBody({ windows: { ...days, mon: ["25:00"] } }),
    );
    expect(badTime.status).toBe(400);
  });
});

describe("POST /content/:id/autoschedule", () => {
  beforeAll(async () => {
    // Las dos marcas, con una sola ventana diaria a las 13:00Z y sin jitter: el
    // resultado es exacto y se puede afirmar al minuto.
    const both = strategyBody({
      networks: [
        { network: "instagram", enabled: true, perDay: 1, dailyCap: 3 },
        { network: "tiktok", enabled: true, perDay: 1, dailyCap: 3 },
        { network: "x", enabled: true, perDay: 1, dailyCap: 3 },
      ],
    });
    expect((await putStrategy(both)).status).toBe(200);
    expect((await putStrategy(both, api.data.b.companyId)).status).toBe(200);
  });

  it("con conexión crea el post SCHEDULED y su job; sin conexión, un slot planificado", async () => {
    const contentId = await newContent(api.data.a.companyId);
    const res = await autoschedule(contentId);
    expect(res.status).toBe(201);
    const body = dataOf(res);

    const created = body["posts"] as {
      platform: string;
      status: string;
      scheduledAtUtc: number;
      _id: string;
    }[];
    expect(created).toHaveLength(1);
    expect(created[0]?.platform).toBe("tiktok");
    expect(created[0]?.status).toBe("SCHEDULED");
    const at = Date.parse("2026-09-21T13:00:00.000Z");
    expect(created[0]?.scheduledAtUtc).toBe(at);

    const jobs = api.queue.forQueue(JOB_QUEUES.publishing);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({
      companyId: api.data.a.companyId,
      postId: created[0]?._id,
    });
    expect(jobs[0]?.options?.startAfter).toEqual(new Date(at));

    const slots = body["plannedSlots"] as {
      network: string;
      status: string;
      scheduledAtUtc: number;
    }[];
    expect(slots.map((s) => s.network).sort()).toEqual(["instagram", "x"]);
    expect(slots.every((s) => s.status === "planned" && s.scheduledAtUtc === at)).toBe(
      true,
    );
  });

  it("repetirlo no vuelve a programar: already_scheduled", async () => {
    const contentId = await newContent(api.data.a.companyId);
    expect((await autoschedule(contentId)).status).toBe(201);
    api.queue.reset();
    const again = dataOf(await autoschedule(contentId));
    expect(again["posts"]).toEqual([]);
    expect(again["plannedSlots"]).toEqual([]);
    expect(
      (again["skipped"] as { reason: string }[]).every(
        (s) => s.reason === "already_scheduled",
      ),
    ).toBe(true);
    expect(api.queue.enqueued).toHaveLength(0);
  });

  it("con el cupo del día lleno, pasa al día siguiente", async () => {
    // Las dos piezas de arriba ya llenaron el lunes (perDay 1) y el martes.
    const contentId = await newContent(api.data.a.companyId);
    const body = dataOf(
      await autoschedule(contentId, undefined, { networks: ["instagram"] }),
    );
    const slots = body["plannedSlots"] as { scheduledAtUtc: number }[];
    expect(slots[0]?.scheduledAtUtc).toBe(Date.parse("2026-09-28T13:00:00.000Z"));
  });

  it("separa las marcas del mismo dueño (10 min)", async () => {
    const contentId = await newContent(api.data.b.companyId);
    const res = await autoschedule(contentId, api.data.b.companyId, {
      networks: ["instagram"],
    });
    expect(res.status).toBe(201);
    const slots = dataOf(res)["plannedSlots"] as { scheduledAtUtc: number }[];
    // La marca `a` tiene piezas a las 13:00 del lunes: `b` sale a las 13:10.
    expect(slots[0]?.scheduledAtUtc).toBe(Date.parse("2026-09-21T13:10:00.000Z"));
  });

  it("contenido ajeno o inexistente: 404; contenido fallido: 409", async () => {
    const ajeno = await newContent(api.data.b.companyId);
    expect((await autoschedule(ajeno)).status).toBe(404);
    expect((await autoschedule(randomUUID())).status).toBe(404);
    expect((await autoschedule("no-uuid")).status).toBe(404);

    const failed = await withoutCompany(api.handle.db, async (tx) => {
      const [row] = await tx
        .insert(contents)
        .values({ companyId: api.data.a.companyId, type: "slideshow", status: "FAILED" })
        .returning({ id: contents.id });
      return row?.id ?? "";
    });
    const res = await autoschedule(failed);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("unsupported_content_state");
  });

  it("sin redes activas: 409 y no escribe nada", async () => {
    const contentId = await newContent(api.data.a.companyId);
    const res = await autoschedule(contentId, undefined, { networks: ["threads"] });
    expect(res.status).toBe(409);
  });
});

describe("GET /posts?from&to", () => {
  const oct1 = Date.parse("2026-10-01T00:00:00.000Z");

  it("trae los posts del rango por fecha efectiva, ascendente", async () => {
    const res = await api.request({
      method: "GET",
      path: `/api/v1/posts?from=${String(oct1)}&to=${String(oct1 + 86_400_000)}`,
    });
    expect(res.status).toBe(200);
    const items = res.body?.["data"] as { _id: string }[];
    expect(items.map((p) => p._id)).toContain(api.data.a.postId);
    expect(items.map((p) => p._id)).not.toContain(api.data.b.postId);
  });

  it("pagina con un cursor propio del modo rango", async () => {
    const from = Date.parse("2026-09-21T00:00:00.000Z");
    const to = Date.parse("2026-10-15T00:00:00.000Z");
    const first = await api.request({
      method: "GET",
      path: `/api/v1/posts?from=${String(from)}&to=${String(to)}&limit=1`,
    });
    const pagination = first.body?.["pagination"] as { cursor: string; hasMore: boolean };
    expect(pagination.hasMore).toBe(true);
    const second = await api.request({
      method: "GET",
      path: `/api/v1/posts?from=${String(from)}&to=${String(to)}&limit=1&cursor=${pagination.cursor}`,
    });
    expect(second.status).toBe(200);
    const a = (first.body?.["data"] as { _id: string }[])[0]?._id;
    const b = (second.body?.["data"] as { _id: string }[])[0]?._id;
    expect(a).not.toBe(b);
  });

  it("un solo extremo, un rango invertido o de más de 62 días: 400", async () => {
    for (const q of [
      `from=${String(oct1)}`,
      `from=${String(oct1)}&to=${String(oct1)}`,
      `from=${String(oct1)}&to=${String(oct1 + 63 * 86_400_000)}`,
    ]) {
      const res = await api.request({ method: "GET", path: `/api/v1/posts?${q}` });
      expect(res.status, q).toBe(400);
    }
  });
});

describe("GET /calendar", () => {
  const from = Date.parse("2026-09-20T00:00:00.000Z");
  const to = Date.parse("2026-10-05T00:00:00.000Z");

  it("esta marca: posts y slots, con tipo y marca", async () => {
    const res = await api.request({
      method: "GET",
      path: `/api/v1/calendar?from=${String(from)}&to=${String(to)}`,
    });
    expect(res.status).toBe(200);
    const cal = dataOf(res);
    const items = cal["items"] as {
      kind: string;
      brandId: string;
      contentType?: string;
      at: number;
    }[];
    expect(items.some((i) => i.kind === "slot")).toBe(true);
    expect(items.some((i) => i.kind === "post")).toBe(true);
    expect(items.every((i) => i.brandId === api.data.a.companyId)).toBe(true);
    expect(items.every((i) => i.contentType === "slideshow")).toBe(true);
    // Ordenados por hora.
    expect(items.map((i) => i.at)).toEqual(
      [...items.map((i) => i.at)].sort((x, y) => x - y),
    );
    const counts = cal["counts"] as { scheduled: number };
    expect(counts.scheduled).toBeGreaterThan(0);
  });

  it("todas las marcas del dueño", async () => {
    const res = await api.request({
      method: "GET",
      path: `/api/v1/calendar?from=${String(from)}&to=${String(to)}&brands=all`,
    });
    const cal = dataOf(res);
    const brandIds = new Set(
      (cal["items"] as { brandId: string }[]).map((i) => i.brandId),
    );
    expect(brandIds).toEqual(new Set([api.data.a.companyId, api.data.b.companyId]));
    const names = (cal["brands"] as { name: string }[]).map((b) => b.name).sort();
    // La marca borrada del fixture no entra.
    expect(names).toEqual(["acme", "globex"]);
  });

  it("rango inválido: 400", async () => {
    const res = await api.request({
      method: "GET",
      path: `/api/v1/calendar?from=${String(to)}&to=${String(from)}`,
    });
    expect(res.status).toBe(400);
  });
});

describe("PATCH /calendar/items/:kind/:id", () => {
  const later = Date.parse("2026-09-25T15:00:00.000Z");

  // `drizzle-orm` no es dependencia de `apps/api`: las lecturas de control van
  // por el cliente SQL del handle, como `truncateAll`.
  async function slotOf(companyId: string): Promise<string> {
    const rows = await api.handle.sql<{ id: string }[]>`
      select id from planned_slots
       where company_id = ${companyId} and status = 'planned'
       order by scheduled_at_utc limit 1
    `;
    const row = rows[0];
    if (row === undefined) throw new Error("no hay slot planificado");
    return row.id;
  }

  it("mueve un slot planificado", async () => {
    const id = await slotOf(api.data.a.companyId);
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/calendar/items/slot/${id}`,
      body: { scheduledAtUtc: later },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)["at"]).toBe(later);
  });

  it("a una hora pasada: 400", async () => {
    const id = await slotOf(api.data.a.companyId);
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/calendar/items/slot/${id}`,
      body: { scheduledAtUtc: NOW - MIN },
    });
    expect(res.status).toBe(400);
  });

  it("un ítem de otra marca: 404 sin brandId, y se mueve con el brandId del mismo dueño", async () => {
    const id = await slotOf(api.data.b.companyId);
    const blind = await api.request({
      method: "PATCH",
      path: `/api/v1/calendar/items/slot/${id}`,
      body: { scheduledAtUtc: later },
    });
    expect(blind.status).toBe(404);

    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/calendar/items/slot/${id}`,
      body: { scheduledAtUtc: later, brandId: api.data.b.companyId },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)["brandName"]).toBe("globex");

    const stranger = await api.request({
      method: "PATCH",
      path: `/api/v1/calendar/items/slot/${id}`,
      body: { scheduledAtUtc: later, brandId: randomUUID() },
    });
    expect(stranger.status).toBe(404);
  });

  it("mover un post lo recrea con su job y cancela el viejo", async () => {
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/calendar/items/post/${api.data.a.postId}`,
      body: { scheduledAtUtc: later },
    });
    expect(res.status).toBe(200);
    const item = dataOf(res);
    expect(item["id"]).not.toBe(api.data.a.postId);
    expect(item["at"]).toBe(later);
    expect(item["status"]).toBe("SCHEDULED");

    const [old] = await api.handle.sql<{ status: string }[]>`
      select status from posts where id = ${api.data.a.postId}
    `;
    expect(old?.status).toBe("CANCELLED");

    const jobs = api.queue.forQueue(JOB_QUEUES.publishing);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({
      companyId: api.data.a.companyId,
      postId: item["id"],
    });
    expect(jobs[0]?.options?.startAfter).toEqual(new Date(later));
  });

  it("un post que ya salió no se mueve (409)", async () => {
    const [row] = await api.handle.sql<{ id: string }[]>`
      update posts set status = 'POSTED', posted_at = ${new Date(NOW - MIN).toISOString()}
       where id = ${api.data.b.postId}
      returning id
    `;
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/calendar/items/post/${row?.id ?? ""}`,
      body: { scheduledAtUtc: later, brandId: api.data.b.companyId },
    });
    expect(res.status).toBe(409);
    expect(api.queue.enqueued).toHaveLength(0);
  });
});

describe("convertPlannedSlot (sprint 3)", () => {
  it("con una conexión activa en la red, el slot pasa a post y queda converted", async () => {
    const contentId = await newContent(api.data.a.companyId);
    const slotId = await withoutCompany(api.handle.db, async (tx) => {
      const [row] = await tx
        .insert(plannedSlots)
        .values({
          companyId: api.data.a.companyId,
          contentId,
          network: "tiktok",
          scheduledAtUtc: new Date("2026-09-30T13:00:00.000Z"),
        })
        .returning({ id: plannedSlots.id });
      return row?.id ?? "";
    });

    const result = await withCompany(
      api.handle.db,
      api.data.a.companyId,
      (tx) =>
        convertPlannedSlot(tx, {
          companyId: api.data.a.companyId,
          slotId,
          nowMs: NOW,
          queue: api.queue,
        }),
      { role: APP_ROLE },
    );
    expect(result.kind).toBe("converted");
    const [slot] = await api.handle.sql<{ status: string; post_id: string | null }[]>`
      select status, post_id from planned_slots where id = ${slotId}
    `;
    expect(slot?.status).toBe("converted");
    expect(slot?.post_id).toBe(result.kind === "converted" ? result.post.id : "x");
    expect(api.queue.forQueue(JOB_QUEUES.publishing)).toHaveLength(1);
  });

  it("en una red sin conexión (o que todavía no es post) espera y no toca nada", async () => {
    const contentId = await newContent(api.data.a.companyId);
    const slotId = await withoutCompany(api.handle.db, async (tx) => {
      const [row] = await tx
        .insert(plannedSlots)
        .values({
          companyId: api.data.a.companyId,
          contentId,
          network: "x",
          scheduledAtUtc: new Date("2026-09-30T13:00:00.000Z"),
        })
        .returning({ id: plannedSlots.id });
      return row?.id ?? "";
    });
    const result = await withCompany(
      api.handle.db,
      api.data.a.companyId,
      (tx) =>
        convertPlannedSlot(tx, {
          companyId: api.data.a.companyId,
          slotId,
          nowMs: NOW,
          queue: api.queue,
        }),
      { role: APP_ROLE },
    );
    expect(result).toEqual({ kind: "wait", reason: "no_connection" });
    expect(api.queue.enqueued).toHaveLength(0);
  });

  // YouTube y LinkedIn se suman con PU-LATER-001/002 (antes LinkedIn esperaba
  // con `network_not_postable` aunque tuviera conexión).
  it.each(["x", "threads", "facebook", "youtube", "linkedin"] as const)(
    "%s (D-09) con una conexión activa única pasa a post de esa red",
    async (network) => {
      const contentId = await newContent(api.data.a.companyId);
      const slotId = await insertSlot(contentId, network);
      const [conn] = await api.handle.sql<{ id: string }[]>`
        insert into connections (company_id, platform, platform_user_id, platform_username, scopes, publishable)
        values (${api.data.a.companyId}, ${network}, ${`${network}-slot`}, ${network}, '{}', true)
        returning id
      `;
      try {
        const result = await convert(slotId);
        expect(result.kind).toBe("converted");
        const [post] = await api.handle.sql<
          { platform: string; connection_id: string; status: string }[]
        >`
          select p.platform, p.connection_id, p.status
          from posts p join planned_slots s on s.post_id = p.id
          where s.id = ${slotId}
        `;
        expect(post).toEqual({
          platform: network,
          connection_id: conn?.id,
          status: "SCHEDULED",
        });
        expect(api.queue.forQueue(JOB_QUEUES.publishing)).toHaveLength(1);
      } finally {
        // Revocada y no borrada: el post la referencia (`posts_account_exclusive`).
        await api.handle.sql`
          update connections set status = 'revoked' where id = ${conn?.id ?? ""}
        `;
      }
    },
  );
});

async function insertSlot(
  contentId: string,
  network: (typeof plannedSlots.$inferInsert)["network"],
): Promise<string> {
  return withoutCompany(api.handle.db, async (tx) => {
    const [row] = await tx
      .insert(plannedSlots)
      .values({
        companyId: api.data.a.companyId,
        contentId,
        network,
        scheduledAtUtc: new Date("2026-09-30T13:00:00.000Z"),
      })
      .returning({ id: plannedSlots.id });
    return row?.id ?? "";
  });
}

function convert(slotId: string) {
  return withCompany(
    api.handle.db,
    api.data.a.companyId,
    (tx) =>
      convertPlannedSlot(tx, {
        companyId: api.data.a.companyId,
        slotId,
        nowMs: NOW,
        queue: api.queue,
      }),
    { role: APP_ROLE },
  );
}
