/**
 * `0021_engagement.sql` — leads, respuestas, cuenta de Reddit, medidor y
 * `app.engagement_brands()`.
 *
 * Lo que mide aislamiento corre con `SET LOCAL ROLE fastgram_app` (como
 * superusuario RLS no aplica y daría verde sin medir nada).
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { engagementStore, type NewLead } from "../src/repositories/index";
import { companies, engagementReplies, leads, redditAccounts } from "../src/schema/index";
import type { Transaction } from "../src/client";
import { APP_ROLE, withCompany, withoutCompany } from "../src/tenancy";
import { seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
let alpha: { companyId: string };
let beta: { companyId: string };
let gone: { companyId: string };

const asApp = <T>(companyId: string, fn: (tx: Transaction) => Promise<T>): Promise<T> =>
  withCompany(ctx.db, companyId, fn, { role: APP_ROLE });

const lead = (postId: string, extra: Partial<NewLead> = {}): NewLead => ({
  redditPostId: postId,
  subreddit: "freelance",
  title: `Post ${postId}`,
  body: "body",
  author: null,
  score: 1,
  permalink: `/r/freelance/comments/${postId}/x/`,
  ...extra,
});

const settings = {
  subreddits: ["freelance"],
  keywords: ["invoice"],
  replyTone: "casual",
  customRules: "",
  allowLinks: false,
  discoveryEnabled: true,
};

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = await seedCompany(ctx.db, { name: "Alpha" });
  beta = await seedCompany(ctx.db, { name: "Beta" });
  gone = await seedCompany(ctx.db, { name: "Gone" });
  await ctx.db
    .update(companies)
    .set({ status: "soft_deleted" })
    .where(eq(companies.id, gone.companyId));
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("app.engagement_brands()", () => {
  it("con fastgram_app lista sólo marcas vivas con configuración, y si tienen cuenta activa", async () => {
    await asApp(alpha.companyId, (tx) =>
      engagementStore.saveSettings(tx, alpha, settings),
    );
    await asApp(gone.companyId, (tx) => engagementStore.saveSettings(tx, gone, settings));
    await asApp(alpha.companyId, (tx) =>
      engagementStore.saveRedditAccount(tx, alpha, {
        redditUserId: "u1",
        username: "me",
        accessToken: "cipher-a",
        refreshToken: "cipher-r",
        tokenExpiry: null,
        scopes: ["identity", "read", "submit"],
      }),
    );
    const rows = await withoutCompany(ctx.db, (tx) => engagementStore.listBrands(tx), {
      role: APP_ROLE,
    });
    expect(rows).toEqual([
      { companyId: alpha.companyId, discoveryEnabled: true, hasRedditAccount: true },
    ]);
    await asApp(alpha.companyId, (tx) =>
      engagementStore.markRedditAccount(tx, alpha, "revoked", "user"),
    );
    const after = await withoutCompany(ctx.db, (tx) => engagementStore.listBrands(tx), {
      role: APP_ROLE,
    });
    expect(after[0]?.hasRedditAccount).toBe(false);
    const [acc] = await ctx.db
      .select()
      .from(redditAccounts)
      .where(eq(redditAccounts.companyId, alpha.companyId));
    // `revoked` borra los tokens cifrados.
    expect(acc?.accessToken).toBeNull();
    expect(acc?.refreshToken).toBeNull();
  });
});

describe("leads", () => {
  it("dedupe por (marca, post), incluidos los descartados; otra marca no choca", async () => {
    const first = await asApp(alpha.companyId, (tx) =>
      engagementStore.insertLeads(tx, alpha, [lead("p1"), lead("p2")]),
    );
    expect(first).toHaveLength(2);
    const again = await asApp(alpha.companyId, (tx) =>
      engagementStore.insertLeads(tx, alpha, [lead("p1"), lead("p3")]),
    );
    expect(again.map((l) => l.redditPostId)).toEqual(["p3"]);
    const other = await asApp(beta.companyId, (tx) =>
      engagementStore.insertLeads(tx, beta, [lead("p1")]),
    );
    expect(other).toHaveLength(1);

    const p2 = first.find((l) => l.redditPostId === "p2");
    if (p2 === undefined) throw new Error("p2");
    await asApp(alpha.companyId, (tx) =>
      engagementStore.softDeleteLead(tx, alpha, p2.id, new Date()),
    );
    const known = await asApp(alpha.companyId, (tx) =>
      engagementStore.knownRedditPostIds(tx, alpha, ["p1", "p2", "p9"]),
    );
    expect([...known].sort()).toEqual(["p1", "p2"]);
    const re = await asApp(alpha.companyId, (tx) =>
      engagementStore.insertLeads(tx, alpha, [lead("p2")]),
    );
    expect(re).toHaveLength(0);
  });

  it("cross-tenant: un lead de otra marca no se lee ni se toca", async () => {
    const [b] = await asApp(beta.companyId, (tx) =>
      engagementStore.insertLeads(tx, beta, [lead("bx")]),
    );
    if (b === undefined) throw new Error("bx");
    // La negativa primero (trampa 35).
    expect(
      await asApp(alpha.companyId, (tx) => engagementStore.findLead(tx, alpha, b.id)),
    ).toBeNull();
    expect(
      await asApp(alpha.companyId, (tx) =>
        engagementStore.updateLead(tx, alpha, b.id, { seenAt: new Date() }),
      ),
    ).toBeNull();
    // Aunque el scope mienta, RLS no deja ver la fila.
    expect(
      await asApp(alpha.companyId, (tx) => engagementStore.findLead(tx, beta, b.id)),
    ).toBeNull();
    expect(
      await asApp(beta.companyId, (tx) => engagementStore.findLead(tx, beta, b.id)),
    ).not.toBeNull();
  });

  it("vistas: hidden/vetoed no se listan; sin juzgar y manuales sí; top ordena por score", async () => {
    const rows = await asApp(alpha.companyId, (tx) =>
      engagementStore.insertLeads(tx, alpha, [
        lead("v-top", {
          scoreStatus: "scored",
          leadTier: "top",
          leadScore: "0.9000",
          engagementScore: "1",
        }),
        lead("v-top2", {
          scoreStatus: "scored",
          leadTier: "top",
          leadScore: "0.8000",
          engagementScore: "50",
        }),
        lead("v-gen", {
          scoreStatus: "scored",
          leadTier: "general",
          leadScore: "0.5000",
        }),
        lead("v-hid", { scoreStatus: "scored", leadTier: "hidden", leadScore: "0.1000" }),
        lead("v-veto", {
          scoreStatus: "scored",
          leadTier: "vetoed",
          leadScore: "0.9500",
        }),
        lead("v-man", {
          scoreStatus: "scored",
          leadTier: "hidden",
          source: "manual",
          title: "Manual invoice",
        }),
      ]),
    );
    expect(rows).toHaveLength(6);
    const q = { unseenOnly: false, limit: 50, offset: 0 } as const;
    const all = await asApp(alpha.companyId, (tx) =>
      engagementStore.listLeads(tx, alpha, { ...q, view: "all" }),
    );
    const ids = all.items.map((l) => l.redditPostId);
    expect(ids).not.toContain("v-hid");
    expect(ids).not.toContain("v-veto");
    expect(ids).toContain("v-man");
    expect(ids).toContain("p1"); // sin juzgar

    const top = await asApp(alpha.companyId, (tx) =>
      engagementStore.listLeads(tx, alpha, { ...q, view: "top" }),
    );
    expect(top.items.map((l) => l.redditPostId)).toEqual(["v-top", "v-top2"]);

    const engaged = await asApp(alpha.companyId, (tx) =>
      engagementStore.listLeads(tx, alpha, { ...q, view: "engaged" }),
    );
    expect(engaged.items[0]?.redditPostId).toBe("v-top2");

    const search = await asApp(alpha.companyId, (tx) =>
      engagementStore.listLeads(tx, alpha, { ...q, view: "all", q: "manual" }),
    );
    expect(search.items.map((l) => l.redditPostId)).toEqual(["v-man"]);
    const pct = await asApp(alpha.companyId, (tx) =>
      engagementStore.listLeads(tx, alpha, { ...q, view: "all", q: "%" }),
    );
    expect(pct.items).toHaveLength(0);

    const seenId = all.items[0]?.id;
    if (seenId === undefined) throw new Error("seen");
    await asApp(alpha.companyId, (tx) =>
      engagementStore.updateLead(tx, alpha, seenId, { seenAt: new Date() }),
    );
    const unseen = await asApp(alpha.companyId, (tx) =>
      engagementStore.listLeads(tx, alpha, { ...q, view: "all", unseenOnly: true }),
    );
    expect(unseen.items.map((l) => l.id)).not.toContain(seenId);

    const page = await asApp(alpha.companyId, (tx) =>
      engagementStore.listLeads(tx, alpha, { ...q, view: "all", limit: 2 }),
    );
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
  });

  it("un lead manual repetido restaura el descartado", async () => {
    const r = await asApp(alpha.companyId, (tx) =>
      engagementStore.upsertManualLead(tx, alpha, lead("p2", { source: "manual" })),
    );
    expect(r.created).toBe(false);
    expect(r.lead.deletedAt).toBeNull();
  });
});

describe("respuestas y medidor", () => {
  it("guarda la respuesta, la etiqueta y el medidor; otra marca no los ve", async () => {
    const [l] = await asApp(alpha.companyId, (tx) =>
      engagementStore.insertLeads(tx, alpha, [lead("r1")]),
    );
    if (l === undefined) throw new Error("r1");
    const sentAt = new Date();
    const reply = await asApp(alpha.companyId, (tx) =>
      engagementStore.insertReply(tx, alpha, {
        leadId: l.id,
        text: "hi",
        channel: "manual",
        redditCommentName: null,
        permalink: null,
        sentAt,
      }),
    );
    const since = new Date(sentAt.getTime() - 60_000);
    const unlabeled = await asApp(alpha.companyId, (tx) =>
      engagementStore.listUnlabeledReplies(tx, alpha, { since, limit: 10 }),
    );
    expect(unlabeled.map((u) => [u.reply.id, u.leadTitle])).toEqual([
      [reply.id, "Post r1"],
    ]);
    await asApp(alpha.companyId, (tx) =>
      engagementStore.setReplyTone(tx, alpha, reply.id, {
        tone: "value_add",
        answers: { promoLevel: { kind: "choice", value: "value_add" } },
        version: "v",
        at: new Date(),
      }),
    );
    expect(
      await asApp(alpha.companyId, (tx) =>
        engagementStore.listRepliesForMeter(tx, alpha, since),
      ),
    ).toEqual([{ sentAt, tone: "value_add" }]);
    expect(
      await asApp(beta.companyId, (tx) =>
        engagementStore.listRepliesForMeter(tx, beta, since),
      ),
    ).toEqual([]);

    await asApp(alpha.companyId, (tx) =>
      engagementStore.saveBanAssessment(tx, alpha, {
        level: "safe",
        promoRatio: "0.0000",
        recommendation: "engagement.banMeter.recommendation.safe",
        computedAt: new Date(),
        sampleSize: 1,
        counts: { valueAdd: 1, subtle: 0, direct: 0, unlabeled: 0 },
        windowDays: 30,
        smallSample: true,
      }),
    );
    expect(
      (await asApp(alpha.companyId, (tx) => engagementStore.findBanAssessment(tx, alpha)))
        ?.level,
    ).toBe("safe");
    expect(
      await asApp(beta.companyId, (tx) => engagementStore.findBanAssessment(tx, beta)),
    ).toBeNull();

    // Un tono fuera del CHECK no entra.
    await expect(
      ctx.db
        .update(engagementReplies)
        .set({ tone: "spam" })
        .where(eq(engagementReplies.id, reply.id)),
    ).rejects.toThrow();
    // Borrar el lead borra sus respuestas (cascade).
    await ctx.db.delete(leads).where(eq(leads.id, l.id));
    expect(
      await ctx.db
        .select()
        .from(engagementReplies)
        .where(eq(engagementReplies.id, reply.id)),
    ).toHaveLength(0);
  });
});
