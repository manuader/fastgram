/**
 * Automations por HTTP — `FR-150`, `F-210…F-220`, `P3-AUTO-001…013`.
 *
 * Lo que persigue este archivo:
 *
 *  - crear en `DRAFT` con el snapshot **congelado** (cambiar las preferencias
 *    de Blitz después no lo toca);
 *  - destinos: una cuenta por red, conexión de la marca y de esa red;
 *  - las reglas duras al generar (`AUTOMATION_NO_CONTENT_TYPE_SELECTED`,
 *    YouTube con slideshow, video-hook sin demo) y la grilla + el job;
 *  - la configuración se bloquea al generar; renombrar no;
 *  - revisión: editar textos/captions/hora, re-roll (con tipo excluido → 400),
 *    remove;
 *  - `launchValidation` y launch: piezas + builds + slots planificados con la
 *    conexión; delete bloqueado mientras `BUILDING`; cancel revoca y limpia;
 *  - ajena, inexistente o no-uuid: el mismo 404, sin efectos.
 *
 * El worker no corre acá: lo que escribiría la generación se simula con SQL
 * (su lógica la mide `apps/worker/test/automations.int.test.ts`).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  automationSchema,
  automationSlotListSchema,
  launchValidationSchema,
} from "@fastgram/contracts";
import { JOB_QUEUES } from "@fastgram/core";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;

beforeAll(async () => {
  // Jueves 24/09/2026 06:00 UTC: la campaña arranca el 28 (lunes).
  api = await startApi({ mode: "personal", now: "2026-09-24T06:00:00.000Z" });
}, 180_000);

afterAll(async () => {
  await api?.close();
});

beforeEach(() => {
  api.queue.reset();
});

const P = "/api/v1";

async function seedMedia(companyId: string, type: "image" | "video", category: string) {
  const mediaId = randomUUID();
  const ext = type === "image" ? "png" : "mp4";
  const url = `https://bucket.test/media/${companyId}/${mediaId}.${ext}`;
  await api.handle.sql`
    insert into media (media_id, company_id, media_type, filename, r2_url, storage_key,
                       status, size_mb, categories, origin)
    values (${mediaId}::uuid, ${companyId}::uuid, ${type}, ${`${mediaId}.${ext}`}, ${url},
            ${`media/${companyId}/${mediaId}.${ext}`}, 'ready', 1, ${[category]}::text[],
            'manual_upload')`;
  return { mediaId, url };
}

const baseBody = () => ({
  name: "Octubre en redes",
  accounts: [
    { platform: "tiktok", accountType: "oauth", connectionId: api.data.a.connectionId },
    { platform: "instagram", accountType: "planned" },
  ],
  perAccountPerDay: 1,
  durationWeeks: 1,
  startDate: "2026-09-28",
  timezone: "UTC",
  prefs: {
    slideshowWeight: 0,
    wallOfTextWeight: 100,
    greenScreenWeight: 0,
    videoHookWeight: 0,
    topics: ["café de especialidad"],
  },
});

async function create(body: unknown = baseBody()) {
  const res = await api.request({ method: "POST", path: `${P}/automations`, body });
  expect(res.status, res.raw).toBe(201);
  return automationSchema.parse(dataOf(res));
}

/** Lo que dejaría el worker: slots READY con plan construible, campaña en REVIEW. */
async function simulateGenerated(automationId: string, mediaId: string, url: string) {
  const slots = await api.handle.sql<{ id: string; slot_index: number }[]>`
    select id, slot_index from automation_slots where automation_id = ${automationId}::uuid`;
  for (const s of slots) {
    const text = `Tres errores al moler café en casa, parte ${String(s.slot_index)}`;
    const data = {
      buildPlan: {
        version: 1,
        media: { format: "wall-of-text", video: { mediaId, url } },
        texts: [text],
      },
      aiExplanation: "Encaja con la marca",
      angleId: null,
      influencerId: null,
      textStylePresetId: null,
      topic: "café de especialidad",
      dedup: { fingerprint: "x", score: 0 },
    };
    await api.handle.sql`
      update automation_slots
         set status = 'READY', suggestion_data = ${JSON.stringify(data)}::jsonb,
             generated_text = ${text},
             captions_by_platform = ${JSON.stringify({
               tiktok: { caption: "Título", description: text },
               instagram: { caption: text },
             })}::jsonb
       where id = ${s.id}::uuid`;
  }
  await api.handle
    .sql`update automations set status = 'REVIEW' where id = ${automationId}::uuid`;
}

describe("crear y configurar (F-210, F-211, F-212)", () => {
  it("DRAFT con el snapshot congelado: cambiar Blitz después no toca la campaña", async () => {
    const created = await create();
    expect(created.status).toBe("DRAFT");
    expect(created.prefsSnapshot.wallOfTextWeight).toBe(100);
    expect(created.prefsSnapshot.topics).toEqual(["café de especialidad"]);
    expect(created.startDate).toBe("2026-09-28");

    const prefs = await api.request({
      method: "PATCH",
      path: `${P}/blitz/preferences`,
      body: { remixPercentage: 77 },
    });
    expect(prefs.status, prefs.raw).toBe(200);
    const again = automationSchema.parse(
      dataOf(
        await api.request({ method: "GET", path: `${P}/automations/${created.id}` }),
      ),
    );
    expect(again.prefsSnapshot.remixPercentage).not.toBe(77);
    expect(again.prefsSnapshot).toEqual(created.prefsSnapshot);
  });

  it("destinos: conexión ajena y dos cuentas de la misma red son 400", async () => {
    const foreign = await api.request({
      method: "POST",
      path: `${P}/automations`,
      body: {
        ...baseBody(),
        accounts: [
          {
            platform: "tiktok",
            accountType: "oauth",
            connectionId: api.data.b.connectionId,
          },
        ],
      },
    });
    expect(foreign.status).toBe(400);
    expect(JSON.stringify(errorOf(foreign).details)).toContain("connection_not_found");

    const twice = await api.request({
      method: "POST",
      path: `${P}/automations`,
      body: {
        ...baseBody(),
        accounts: [
          { platform: "instagram", accountType: "planned" },
          { platform: "instagram", accountType: "planned" },
        ],
      },
    });
    expect(twice.status).toBe(400);
  });

  it("rangos de DATA-021 por contrato", async () => {
    const res = await api.request({
      method: "POST",
      path: `${P}/automations`,
      body: { ...baseBody(), perAccountPerDay: 4 },
    });
    expect(res.status).toBe(400);
  });
});

describe("generar (F-213) y reglas duras (FR-150)", () => {
  it("todos los pesos en 0 → 422 AUTOMATION_NO_CONTENT_TYPE_SELECTED, sin slots ni job", async () => {
    const created = await create({
      ...baseBody(),
      prefs: {
        slideshowWeight: 0,
        wallOfTextWeight: 0,
        greenScreenWeight: 0,
        videoHookWeight: 0,
      },
    });
    const res = await api.request({
      method: "POST",
      path: `${P}/automations/${created.id}/generate`,
    });
    expect(api.queue.forQueue(JOB_QUEUES.automationGeneration)).toHaveLength(0);
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe("AUTOMATION_NO_CONTENT_TYPE_SELECTED");
  });

  it("YouTube con slideshowWeight > 0 bloquea la generación (P3-AUTO-011)", async () => {
    await seedMedia(api.data.a.companyId, "image", "slideshow-image");
    const created = await create({
      ...baseBody(),
      accounts: [{ platform: "youtube", accountType: "planned" }],
      prefs: {
        slideshowWeight: 50,
        wallOfTextWeight: 50,
        greenScreenWeight: 0,
        videoHookWeight: 0,
      },
    });
    const res = await api.request({
      method: "POST",
      path: `${P}/automations/${created.id}/generate`,
    });
    expect(api.queue.forQueue(JOB_QUEUES.automationGeneration)).toHaveLength(0);
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toMatchObject({
      reason: "AUTOMATION_YOUTUBE_REQUIRES_NO_SLIDESHOW",
    });
  });

  it("video-hook sin demo video → 422 AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO", async () => {
    const created = await create({
      ...baseBody(),
      prefs: {
        slideshowWeight: 0,
        wallOfTextWeight: 0,
        greenScreenWeight: 0,
        videoHookWeight: 100,
      },
    });
    const res = await api.request({
      method: "POST",
      path: `${P}/automations/${created.id}/generate`,
    });
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe("AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO");
  });

  it("crea la grilla (1/día × 7) en PENDING_GEN, encola el job y bloquea la config", async () => {
    await seedMedia(api.data.a.companyId, "video", "background-video");
    const created = await create();
    const res = await api.request({
      method: "POST",
      path: `${P}/automations/${created.id}/generate`,
    });
    expect(res.status, res.raw).toBe(202);
    const after = automationSchema.parse(dataOf(res));
    expect(after.status).toBe("GENERATING");
    expect(after.progress.total).toBe(7);
    expect(after.generationQuota).toBe(14);
    const jobs = api.queue.forQueue(JOB_QUEUES.automationGeneration);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toEqual({
      companyId: api.data.a.companyId,
      automationId: created.id,
    });

    const slots = automationSlotListSchema.parse(
      dataOf(
        await api.request({
          method: "GET",
          path: `${P}/automations/${created.id}/slots`,
        }),
      ),
    );
    expect(slots.map((s) => s.status)).toEqual(Array(7).fill("PENDING_GEN"));
    // AI-012: sólo wall-of-text (los demás pesan 0).
    expect(new Set(slots.map((s) => s.contentType))).toEqual(new Set(["wall-of-text"]));

    const locked = await api.request({
      method: "PATCH",
      path: `${P}/automations/${created.id}`,
      body: { durationWeeks: 2 },
    });
    expect(locked.status).toBe(409);
    const renamed = await api.request({
      method: "PATCH",
      path: `${P}/automations/${created.id}`,
      body: { name: "Nuevo nombre" },
    });
    expect(renamed.status).toBe(200);
    expect(automationSchema.parse(dataOf(renamed)).name).toBe("Nuevo nombre");

    const again = await api.request({
      method: "POST",
      path: `${P}/automations/${created.id}/generate`,
    });
    expect(again.status).toBe(409);
  });
});

describe("revisión, launchValidation y launch (F-214…F-217, F-219)", () => {
  it("de REVIEW a BUILDING y a CANCELLED, con todos los efectos", async () => {
    const { mediaId, url } = await seedMedia(
      api.data.a.companyId,
      "video",
      "background-video",
    );
    const created = await create();
    expect(
      (
        await api.request({
          method: "POST",
          path: `${P}/automations/${created.id}/generate`,
        })
      ).status,
    ).toBe(202);
    await simulateGenerated(created.id, mediaId, url);
    const slots = automationSlotListSchema.parse(
      dataOf(
        await api.request({
          method: "GET",
          path: `${P}/automations/${created.id}/slots`,
        }),
      ),
    );
    expect(slots.every((s) => s.status === "READY")).toBe(true);
    const [first, second, third] = slots;
    if (first === undefined || second === undefined || third === undefined)
      throw new Error("slots");
    expect(first.preview).toEqual({ url, kind: "video" });

    // (1) textos + (2) captions + (3) hora
    const edited = await api.request({
      method: "PATCH",
      path: `${P}/automations/${created.id}/slots/${first.id}`,
      body: {
        texts: ["Texto nuevo del primer post"],
        captionsByPlatform: { tiktok: { caption: "Otro título", description: "Cuerpo" } },
        scheduledAt: Date.parse("2026-09-28T15:30:00Z"),
      },
    });
    expect(edited.status, edited.raw).toBe(200);
    const e = dataOf(edited);
    expect(e["generatedText"]).toBe("Texto nuevo del primer post");
    // El mapa se reemplaza entero: instagram se borró.
    expect(Object.keys(e["captionsByPlatform"] as object)).toEqual(["tiktok"]);
    expect(e["scheduledAt"]).toBe(Date.parse("2026-09-28T15:30:00Z"));

    const badCaption = await api.request({
      method: "PATCH",
      path: `${P}/automations/${created.id}/slots/${first.id}`,
      body: { captionsByPlatform: { youtube: { caption: "no es destino" } } },
    });
    expect(badCaption.status).toBe(400);

    // Re-roll con un tipo en 0 → 400; sin forzar → 202 REROLLING + job.
    api.queue.reset();
    const excluded = await api.request({
      method: "POST",
      path: `${P}/automations/${created.id}/slots/${second.id}/reroll`,
      body: { contentType: "green-screen" },
    });
    expect(api.queue.forQueue(JOB_QUEUES.automationGeneration)).toHaveLength(0);
    expect(excluded.status).toBe(400);
    const reroll = await api.request({
      method: "POST",
      path: `${P}/automations/${created.id}/slots/${second.id}/reroll`,
      body: {},
    });
    expect(reroll.status, reroll.raw).toBe(202);
    expect(dataOf(reroll)["status"]).toBe("REROLLING");
    expect(dataOf(reroll)["generatedText"]).toBeNull();
    expect(api.queue.forQueue(JOB_QUEUES.automationGeneration)[0]?.payload).toMatchObject(
      {
        slotId: second.id,
      },
    );

    // Con un re-roll en curso no se lanza: el gate lo dice (y el launch 409).
    const blocked = launchValidationSchema.parse(
      dataOf(
        await api.request({
          method: "GET",
          path: `${P}/automations/${created.id}/launch-validation`,
        }),
      ),
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.gates.map((g) => g.code)).toContain("content_generating");
    const refused = await api.request({
      method: "POST",
      path: `${P}/automations/${created.id}/launch`,
    });
    expect(refused.status).toBe(409);
    expect(JSON.stringify(errorOf(refused).details)).toContain("content_generating");

    // El worker termina el re-roll; y se saca un post ("Won't post").
    await api.handle.sql`
      update automation_slots set status = 'READY',
        suggestion_data = (select suggestion_data from automation_slots where id = ${third.id}::uuid),
        generated_text = 'Otra copy distinta para el segundo'
       where id = ${second.id}::uuid`;
    const removed = await api.request({
      method: "DELETE",
      path: `${P}/automations/${created.id}/slots/${third.id}`,
    });
    expect(removed.status).toBe(200);
    expect(dataOf(removed)["status"]).toBe("CANCELLED");

    const ok = launchValidationSchema.parse(
      dataOf(
        await api.request({
          method: "GET",
          path: `${P}/automations/${created.id}/launch-validation`,
        }),
      ),
    );
    expect(ok.gates).toEqual([]);
    expect(ok.summary).toMatchObject({ readySlots: 6, destinations: 2, posts: 12 });

    api.queue.reset();
    const launched = await api.request({
      method: "POST",
      path: `${P}/automations/${created.id}/launch`,
    });
    expect(launched.status, launched.raw).toBe(200);
    expect(automationSchema.parse(dataOf(launched)).status).toBe("BUILDING");
    expect(api.queue.forQueue(JOB_QUEUES.contentBuild)).toHaveLength(6);
    expect(api.queue.forQueue(JOB_QUEUES.automationBuildSchedule)).toHaveLength(1);
    const reserved = await api.handle.sql<
      { network: string; connection_id: string | null }[]
    >`
      select network, connection_id from planned_slots
       where automation_slot_id in (select id from automation_slots where automation_id = ${created.id}::uuid)`;
    expect(reserved).toHaveLength(12);
    expect(
      reserved
        .filter((r) => r.network === "tiktok")
        .every((r) => r.connection_id === api.data.a.connectionId),
    ).toBe(true);
    expect(
      reserved
        .filter((r) => r.network === "instagram")
        .every((r) => r.connection_id === null),
    ).toBe(true);
    const pieces = await api.handle.sql<{ status: string }[]>`
      select c.status from contents c join automation_slots s on s.content_id = c.id
       where s.automation_id = ${created.id}::uuid`;
    expect(pieces).toHaveLength(6);
    expect(pieces.every((p) => p.status === "BUILDING")).toBe(true);

    // Lanzada no se edita ni se borra.
    const editAfter = await api.request({
      method: "PATCH",
      path: `${P}/automations/${created.id}/slots/${first.id}`,
      body: { texts: ["tarde"] },
    });
    expect(editAfter.status).toBe(409);
    const del = await api.request({
      method: "DELETE",
      path: `${P}/automations/${created.id}`,
    });
    expect(del.status).toBe(409);

    // Cancel: slots planificados fuera, slots CANCELLED; después sí se borra.
    const cancelled = await api.request({
      method: "POST",
      path: `${P}/automations/${created.id}/cancel`,
    });
    expect(cancelled.status, cancelled.raw).toBe(200);
    expect(automationSchema.parse(dataOf(cancelled)).status).toBe("CANCELLED");
    const left = await api.handle.sql`
      select 1 from planned_slots
       where automation_slot_id in (select id from automation_slots where automation_id = ${created.id}::uuid)`;
    expect(left).toHaveLength(0);
    const after = automationSlotListSchema.parse(
      dataOf(
        await api.request({
          method: "GET",
          path: `${P}/automations/${created.id}/slots`,
        }),
      ),
    );
    expect(after.every((s) => s.status === "CANCELLED")).toBe(true);
    const deleted = await api.request({
      method: "DELETE",
      path: `${P}/automations/${created.id}`,
    });
    expect(deleted.status).toBe(204);
  });

  it("cancelar revoca los posts programados y deja vivos los publicados (criterio 3)", async () => {
    const { mediaId, url } = await seedMedia(
      api.data.a.companyId,
      "video",
      "background-video",
    );
    const created = await create();
    await api.request({
      method: "POST",
      path: `${P}/automations/${created.id}/generate`,
    });
    await simulateGenerated(created.id, mediaId, url);
    const launched = await api.request({
      method: "POST",
      path: `${P}/automations/${created.id}/launch`,
    });
    expect(launched.status, launched.raw).toBe(200);
    const slots = await api.handle.sql<{ id: string; content_id: string }[]>`
      select id, content_id from automation_slots where automation_id = ${created.id}::uuid order by slot_index`;
    const [a, b] = slots;
    if (a === undefined || b === undefined) throw new Error("slots");
    const companyId = api.data.a.companyId;
    const connectionId = api.data.a.connectionId;
    await api.handle.sql`
      insert into posts (company_id, content_id, platform, account_type, connection_id,
                         scheduled_at_utc, status, automation_slot_id, posted_at)
      values (${companyId}::uuid, ${a.content_id}::uuid, 'tiktok', 'oauth', ${connectionId}::uuid,
              now(), 'POSTED', ${a.id}::uuid, now()),
             (${companyId}::uuid, ${b.content_id}::uuid, 'tiktok', 'oauth', ${connectionId}::uuid,
              now() + interval '2 days', 'SCHEDULED', ${b.id}::uuid, null)`;
    await api.handle
      .sql`update automation_slots set status = 'SCHEDULED' where id in (${a.id}::uuid, ${b.id}::uuid)`;
    await api.handle
      .sql`update automations set status = 'ACTIVE' where id = ${created.id}::uuid`;

    const res = await api.request({
      method: "POST",
      path: `${P}/automations/${created.id}/cancel`,
    });
    expect(res.status, res.raw).toBe(200);
    const postRows = await api.handle.sql<
      { status: string; automation_slot_id: string }[]
    >`
      select status, automation_slot_id from posts
       where automation_slot_id in (${a.id}::uuid, ${b.id}::uuid)`;
    expect(postRows.find((p) => p.automation_slot_id === a.id)?.status).toBe("POSTED");
    expect(postRows.find((p) => p.automation_slot_id === b.id)?.status).toBe("CANCELLED");
    const slotRows = await api.handle.sql<{ id: string; status: string }[]>`
      select id, status from automation_slots where id in (${a.id}::uuid, ${b.id}::uuid)`;
    expect(slotRows.find((s) => s.id === a.id)?.status).toBe("SCHEDULED");
    expect(slotRows.find((s) => s.id === b.id)?.status).toBe("CANCELLED");
    const detail = automationSchema.parse(
      dataOf(
        await api.request({ method: "GET", path: `${P}/automations/${created.id}` }),
      ),
    );
    expect(detail.stats).toMatchObject({ published: 1, failed: 0 });
  });
});

describe("cross-tenant: el mismo 404, sin efectos", () => {
  it("la campaña de b no existe para a en ninguna ruta", async () => {
    const other = await api.request({
      method: "POST",
      path: `${P}/automations`,
      token: api.data.b.token,
      body: {
        ...baseBody(),
        accounts: [
          {
            platform: "tiktok",
            accountType: "oauth",
            connectionId: api.data.b.connectionId,
          },
        ],
      },
    });
    expect(other.status, other.raw).toBe(201);
    const id = String(dataOf(other)["id"]);
    const slotId = randomUUID();
    const unknown = api.data.unknownId;

    const calls: [string, string, unknown?][] = [
      ["GET", `/automations/${id}`],
      ["PATCH", `/automations/${id}`, { name: "robado" }],
      ["DELETE", `/automations/${id}`],
      ["POST", `/automations/${id}/generate`],
      ["GET", `/automations/${id}/slots`],
      [
        "PATCH",
        `/automations/${id}/slots/${slotId}`,
        { scheduledAt: Date.parse("2026-10-01T10:00:00Z") },
      ],
      ["DELETE", `/automations/${id}/slots/${slotId}`],
      ["POST", `/automations/${id}/slots/${slotId}/reroll`, {}],
      ["POST", `/automations/${id}/slots/${slotId}/content`],
      ["GET", `/automations/${id}/launch-validation`],
      ["POST", `/automations/${id}/launch`],
      ["POST", `/automations/${id}/cancel`],
    ];
    for (const [method, path, body] of calls) {
      const res = await api.request({
        method: method as "GET",
        path: `${P}${path}`,
        ...(body === undefined ? {} : { body }),
      });
      const ghost = await api.request({
        method: method as "GET",
        path: `${P}${path.replace(id, unknown)}`,
        ...(body === undefined ? {} : { body }),
      });
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(res.raw, `${method} ${path}`).toBe(ghost.raw);
    }
    expect(api.queue.forQueue(JOB_QUEUES.automationGeneration)).toHaveLength(0);
    const still = await api.request({
      method: "GET",
      path: `${P}/automations/${id}`,
      token: api.data.b.token,
    });
    expect(dataOf(still)["name"]).toBe("Octubre en redes");
    expect(dataOf(still)["status"]).toBe("DRAFT");

    const list = await api.request({ method: "GET", path: `${P}/automations` });
    expect((dataOf(list) as unknown as { id: string }[]).some((a) => a.id === id)).toBe(
      false,
    );
  });
});
