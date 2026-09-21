/**
 * Los números del PRD, pero verificados contra Postgres.
 *
 * `limits.test.ts` fija los valores de las constantes; esto verifica que la base
 * **rechaza** lo que está fuera de rango. Son dos cosas distintas y las dos hacen falta:
 * una constante correcta que nadie usa en un CHECK no protege nada.
 *
 * Todas las inserciones van como superusuario, sin `SET ROLE`: los CHECK no dependen
 * de RLS y mezclarlos haría ambiguo qué falló.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  automations,
  blitzPreferences,
  connections,
  contentTextBoxes,
  contents,
  influencers,
  posts,
} from "../src/schema/index";
import { seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
let companyId: string;
let contentId: string;
let connectionId: string;

beforeAll(async () => {
  ctx = await startTestDatabase();
  companyId = (await seedCompany(ctx.db, { name: "Constraints" })).companyId;

  contentId = randomUUID();
  await ctx.db.insert(contents).values({ id: contentId, companyId, type: "slideshow" });

  connectionId = randomUUID();
  await ctx.db.insert(connections).values({
    id: connectionId,
    companyId,
    platform: "tiktok",
    platformUserId: "u1",
    platformUsername: "handle",
  });
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

const influencer = (age: number, progress = 0) => ({
  companyId,
  name: "Test",
  gender: "woman",
  age,
  ethnicity: "n/a",
  progress,
});

describe("DATA-013 · edad de influencer 18–60", () => {
  it("acepta los dos extremos", async () => {
    await expect(
      ctx.db.insert(influencers).values([influencer(18), influencer(60)]),
    ).resolves.toBeDefined();
  });

  it("rechaza 17 y 61", async () => {
    await expect(ctx.db.insert(influencers).values(influencer(17))).rejects.toThrow(
      /influencers_age_range/,
    );
    await expect(ctx.db.insert(influencers).values(influencer(61))).rejects.toThrow(
      /influencers_age_range/,
    );
  });

  it("rechaza progress fuera de 0–100", async () => {
    await expect(ctx.db.insert(influencers).values(influencer(30, 101))).rejects.toThrow(
      /influencers_progress_range/,
    );
  });
});

describe("FR-070 · máximo 20 slides por slideshow", () => {
  it("acepta 20 archivos", async () => {
    await expect(
      ctx.db.insert(contents).values({
        companyId,
        type: "slideshow",
        files: Array.from({ length: 20 }, (_, i) => `https://cdn/${i}.jpg`),
      }),
    ).resolves.toBeDefined();
  });

  it("rechaza 21", async () => {
    await expect(
      ctx.db.insert(contents).values({
        companyId,
        type: "slideshow",
        files: Array.from({ length: 21 }, (_, i) => `https://cdn/${i}.jpg`),
      }),
    ).rejects.toThrow(/contents_files_max_slides/);
  });
});

describe("DATA-006 · los cuatro pesos de formato suman 100", () => {
  const prefs = (weights: [number, number, number, number]) => ({
    companyId,
    slideshowWeight: weights[0],
    wallOfTextWeight: weights[1],
    greenScreenWeight: weights[2],
    videoHookWeight: weights[3],
    remixPercentage: 50,
    ownMediaPercentage: 50,
    mentionBusinessPercentage: 50,
    influencerChance: 50,
  });

  it("rechaza 99 y 101", async () => {
    await expect(
      ctx.db.insert(blitzPreferences).values(prefs([25, 25, 25, 24])),
    ).rejects.toThrow(/blitz_preferences_format_weights_sum/);
    await expect(
      ctx.db.insert(blitzPreferences).values(prefs([25, 25, 25, 26])),
    ).rejects.toThrow(/blitz_preferences_format_weights_sum/);
  });

  it("acepta exactamente 100", async () => {
    await expect(
      ctx.db.insert(blitzPreferences).values(prefs([25, 25, 25, 25])),
    ).resolves.toBeDefined();
  });

  it("rechaza un porcentaje > 100", async () => {
    const bad = { ...prefs([25, 25, 25, 25]), influencerChance: 101 };
    await expect(ctx.db.insert(blitzPreferences).values(bad)).rejects.toThrow(
      /blitz_preferences_percentage_ranges/,
    );
  });
});

describe("DATA-009 · rangos del ContentTextBox", () => {
  const box = (overrides: Record<string, unknown> = {}) => ({
    id: `slide-0-text-${randomUUID().slice(0, 8)}`,
    contentId,
    companyId,
    text: "hola",
    position: { x: 50, y: 50 },
    widthPercent: 50,
    font: { family: "Inter", weight: 700, size: 24 },
    color: "#FF00AA",
    stroke: { width: 2, color: "#000000" },
    background: { color: "#000000", opacity: 0.5, style: "pill" },
    ...overrides,
  });

  it("acepta una caja válida", async () => {
    await expect(ctx.db.insert(contentTextBoxes).values(box())).resolves.toBeDefined();
  });

  it("widthPercent 25–100", async () => {
    await expect(
      ctx.db.insert(contentTextBoxes).values(box({ widthPercent: 24 })),
    ).rejects.toThrow(/content_text_boxes_width_percent_range/);
    await expect(
      ctx.db.insert(contentTextBoxes).values(box({ widthPercent: 101 })),
    ).rejects.toThrow(/content_text_boxes_width_percent_range/);
  });

  it("font.size 8–72", async () => {
    await expect(
      ctx.db
        .insert(contentTextBoxes)
        .values(box({ font: { family: "Inter", weight: 400, size: 7 } })),
    ).rejects.toThrow(/content_text_boxes_font_size_range/);
    await expect(
      ctx.db
        .insert(contentTextBoxes)
        .values(box({ font: { family: "Inter", weight: 400, size: 73 } })),
    ).rejects.toThrow(/content_text_boxes_font_size_range/);
  });

  it("position 0–100", async () => {
    await expect(
      ctx.db.insert(contentTextBoxes).values(box({ position: { x: 101, y: 0 } })),
    ).rejects.toThrow(/content_text_boxes_position_range/);
  });

  it("stroke.width 0–8", async () => {
    await expect(
      ctx.db
        .insert(contentTextBoxes)
        .values(box({ stroke: { width: 9, color: "#000000" } })),
    ).rejects.toThrow(/content_text_boxes_stroke_width_range/);
  });

  it("background.opacity 0–1 y style ∈ {pill, full-width}", async () => {
    await expect(
      ctx.db
        .insert(contentTextBoxes)
        .values(box({ background: { color: "#000", opacity: 1.5, style: "pill" } })),
    ).rejects.toThrow(/content_text_boxes_background_shape/);
    await expect(
      ctx.db
        .insert(contentTextBoxes)
        .values(box({ background: { color: "#000", opacity: 1, style: "square" } })),
    ).rejects.toThrow(/content_text_boxes_background_shape/);
  });

  it("color en #RRGGBB", async () => {
    await expect(
      ctx.db.insert(contentTextBoxes).values(box({ color: "red" })),
    ).rejects.toThrow(/content_text_boxes_color_hex/);
  });
});

describe("DATA-021 · rangos de Automation", () => {
  const automation = (perDay: number, weeks: number) => ({
    companyId,
    name: "Campaña",
    perAccountPerDay: perDay,
    durationWeeks: weeks,
    startDateUtc: new Date(),
    timezone: "UTC",
  });

  it("perAccountPerDay 1–3", async () => {
    await expect(
      ctx.db.insert(automations).values(automation(3, 1)),
    ).resolves.toBeDefined();
    await expect(ctx.db.insert(automations).values(automation(4, 1))).rejects.toThrow(
      /automations_per_account_per_day_range/,
    );
    await expect(ctx.db.insert(automations).values(automation(0, 1))).rejects.toThrow(
      /automations_per_account_per_day_range/,
    );
  });

  it("durationWeeks 1–4", async () => {
    await expect(
      ctx.db.insert(automations).values(automation(1, 4)),
    ).resolves.toBeDefined();
    await expect(ctx.db.insert(automations).values(automation(1, 5))).rejects.toThrow(
      /automations_duration_weeks_range/,
    );
  });
});

describe("DATA-020 / FR-060 · cuenta del Post", () => {
  const post = (overrides: Record<string, unknown> = {}) => ({
    companyId,
    contentId,
    platform: "tiktok" as const,
    accountType: "oauth" as const,
    connectionId,
    scheduledAtUtc: new Date(),
    ...overrides,
  });

  it("acepta oauth con connectionId", async () => {
    await expect(ctx.db.insert(posts).values(post())).resolves.toBeDefined();
  });

  it("rechaza que connectionId y warmedAccountId convivan", async () => {
    await expect(
      ctx.db.insert(posts).values(post({ warmedAccountId: randomUUID() })),
    ).rejects.toThrow(/posts_account_exclusive|foreign key/i);
  });

  it("rechaza que falten los dos", async () => {
    await expect(
      ctx.db.insert(posts).values(post({ connectionId: null })),
    ).rejects.toThrow(/posts_account_exclusive/);
  });

  it("rechaza accountType que no coincide con la columna poblada", async () => {
    await expect(
      ctx.db.insert(posts).values(post({ accountType: "warmed" })),
    ).rejects.toThrow(/posts_account_type_matches|posts_account_exclusive/);
  });
});
