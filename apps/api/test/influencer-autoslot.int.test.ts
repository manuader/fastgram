/**
 * Sprint 7 (segunda tanda) — el auto-slot de una pieza hecha con un influencer
 * prefiere las redes y cuentas marcadas en su Configuration (`FR-083`,
 * `influencer_configs.publishing_accounts`). La pieza sabe su influencer por
 * `contents.influencer_id` (migración `0032`).
 *
 * Reloj del arnés: lunes 2026-09-21 12:00Z. El fixture trae una conexión
 * TikTok activa por marca.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { contents, influencerConfigs, withoutCompany } from "@fastgram/db";

import { dataOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;
let igUno = "";
let igDos = "";

const days = { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] };

beforeAll(async () => {
  api = await startApi({ mode: "personal" });
  const put = await api.request({
    method: "PUT",
    path: "/api/v1/strategy",
    body: {
      networks: [
        { network: "instagram", enabled: true, perDay: 1, dailyCap: 3 },
        { network: "tiktok", enabled: true, perDay: 1, dailyCap: 3 },
        { network: "x", enabled: true, perDay: 1, dailyCap: 3 },
      ],
      windows: { ...days, mon: ["13:00"], tue: ["13:00"] },
      timezone: "UTC",
      language: "es",
      autonomy: "manual",
      jitterMinutes: 0,
      brandGapMinutes: 10,
      formatMix: { slideshow: 100 },
    },
  });
  expect(put.status).toBe(200);
  // Dos cuentas de Instagram: sin preferencia, el slot sería ambiguo y esperaría.
  const rows = await api.handle.sql<{ id: string }[]>`
    insert into connections (company_id, platform, platform_user_id, platform_username, scopes, publishable)
    values (${api.data.a.companyId}, 'instagram', 'ig-uno', 'uno', '{}', true),
           (${api.data.a.companyId}, 'instagram', 'ig-dos', 'dos', '{}', true)
    returning id
  `;
  igUno = rows[0]?.id ?? "";
  igDos = rows[1]?.id ?? "";
}, 180_000);

afterAll(async () => {
  await api?.close();
});

async function newContent(influencerId: string | null): Promise<string> {
  return withoutCompany(api.handle.db, async (tx) => {
    const [row] = await tx
      .insert(contents)
      .values({
        companyId: api.data.a.companyId,
        type: "slideshow",
        status: "CREATED",
        influencerId,
      })
      .returning({ id: contents.id });
    if (row === undefined) throw new Error("no se creó el contenido");
    return row.id;
  });
}

async function configure(accounts: unknown[]): Promise<void> {
  await withoutCompany(api.handle.db, async (tx) => {
    await tx
      .insert(influencerConfigs)
      .values({
        influencerId: api.data.a.influencerId,
        companyId: api.data.a.companyId,
        publishingAccounts: accounts,
      })
      .onConflictDoUpdate({
        target: influencerConfigs.influencerId,
        set: { publishingAccounts: accounts },
      });
  });
}

const autoschedule = (contentId: string, body: unknown = {}) =>
  api.request({
    method: "POST",
    path: `/api/v1/content/${contentId}/autoschedule`,
    body,
  });

type Result = {
  posts: { platform: string; connectionId?: string }[];
  plannedSlots: { network: string }[];
};

describe("POST /content/:id/autoschedule · cuentas del influencer", () => {
  it("con una cuenta marcada: sólo esa red, y el post sale con esa cuenta", async () => {
    await configure([{ platform: "instagram", connectionId: igDos, enabled: true }]);
    const contentId = await newContent(api.data.a.influencerId);

    const res = await autoschedule(contentId);
    expect(res.status).toBe(201);
    const body = dataOf(res) as unknown as Result;
    expect(body.plannedSlots).toEqual([]);
    expect(body.posts.map((p) => p.platform)).toEqual(["instagram"]);
    const [post] = await api.handle.sql<{ connection_id: string }[]>`
      select connection_id from posts where content_id = ${contentId}::uuid
    `;
    expect(post?.connection_id).toBe(igDos);
  });

  it("una pieza sin influencer programa todas las redes como siempre", async () => {
    const contentId = await newContent(null);
    const body = dataOf(await autoschedule(contentId)) as unknown as Result;
    // TikTok tiene una sola conexión → post; Instagram tiene dos → slot
    // ambiguo; X no tiene → slot.
    expect(body.posts.map((p) => p.platform)).toEqual(["tiktok"]);
    expect(body.plannedSlots.map((s) => s.network).sort()).toEqual(["instagram", "x"]);
  });

  it("las redes elegidas a mano mandan sobre la preferencia", async () => {
    await configure([{ platform: "instagram", connectionId: igUno, enabled: true }]);
    const contentId = await newContent(api.data.a.influencerId);
    const body = dataOf(
      await autoschedule(contentId, { networks: ["x"] }),
    ) as unknown as Result;
    expect(body.posts).toEqual([]);
    expect(body.plannedSlots.map((s) => s.network)).toEqual(["x"]);
  });

  it("una cuenta marcada desconectada no cuenta: sin preferencia", async () => {
    await configure([
      {
        platform: "instagram",
        connectionId: "00000000-0000-4000-8000-000000000000",
        enabled: true,
      },
    ]);
    const contentId = await newContent(api.data.a.influencerId);
    const body = dataOf(await autoschedule(contentId)) as unknown as Result;
    expect(body.posts.map((p) => p.platform)).toEqual(["tiktok"]);
    expect(body.plannedSlots.map((s) => s.network).sort()).toEqual(["instagram", "x"]);
  });
});
