import { describe, expect, it } from "vitest";
import type { Rng } from "@fastgram/ports";
import type { BlitzPreferences } from "../discovery/blitz-preferences.js";
import { buildMediaBank, type PlanningMedia } from "../discovery/blitz-media.js";
import type { BlitzPlanningContext } from "../discovery/plan-blitz-suggestion.js";
import { DomainError } from "../errors.js";
import { zonedWallTimeToUtc } from "../scheduling/zoned-time.js";
import {
  AUTOMATION_SLOT_STATUSES,
  AUTOMATION_STATUSES,
  AutomationGenerationBlocked,
  accountProblems,
  assertGenerationAllowed,
  assertValidSchedulingConfig,
  automationSlotCount,
  buildPrefsSnapshot,
  campaignContentTypes,
  canDeleteAutomation,
  canTransitionAutomation,
  canTransitionSlot,
  parsePrefsSnapshot,
  patchPrefsSnapshot,
  rerollTypeProblem,
  topicForSlot,
  type AutomationAccount,
  type AutomationPrefsSnapshot,
} from "./model.js";
import {
  apportionContentTypes,
  assignContentTypes,
  planCampaignSchedule,
  timesForDay,
} from "./schedule.js";
import { dedupFingerprint, judgeDuplicate, normalizeForDedup } from "./dedup.js";
import { applyTextEdit, captionProblems, defaultCaptions } from "./review.js";
import { evaluateLaunchGates, type LaunchGateInput } from "./launch.js";
import {
  automationStatusAfterBuilds,
  isAutomationComplete,
  slotStatusForContent,
  slotStatusOnCancel,
} from "./lifecycle.js";
import {
  isAutomationCampaignPayload,
  parseAutomationBuildJob,
  parseAutomationCampaignJob,
} from "./jobs.js";
import { planAutomationSlot } from "./plan-slot.js";

const brandPrefs = (over: Partial<BlitzPreferences> = {}): BlitzPreferences => ({
  slideshowWeight: 25,
  wallOfTextWeight: 25,
  greenScreenWeight: 25,
  videoHookWeight: 25,
  remixPercentage: 0,
  ownMediaPercentage: 100,
  mentionBusinessPercentage: 0,
  influencerChance: 0,
  smartTextPositioning: true,
  genderFilter: null,
  angleWeights: {},
  textStyleWeights: {},
  ...over,
});

const oauth = (platform: AutomationAccount["platform"], connectionId = "c-" + platform) =>
  ({ platform, accountType: "oauth", connectionId }) as const;

/** Un Rng con la secuencia dada (en ronda). */
function scriptedRng(values: readonly number[]): Rng {
  let i = 0;
  const next = () => {
    const v = values[i % values.length] as number;
    i += 1;
    return v;
  };
  return {
    next,
    nextInt: (min, max) => min + Math.floor(next() * (max - min)),
    weightedPick<T>(items: readonly { value: T; weight: number }[]): T {
      const total = items.reduce((s, it) => s + it.weight, 0);
      if (items.length === 0 || total <= 0) throw new Error("weightedPick sin peso");
      let target = next() * total;
      for (const item of items) {
        target -= item.weight;
        if (target < 0) return item.value;
      }
      return items[items.length - 1]!.value;
    },
  };
}

const img = (id: string, ...categories: string[]): PlanningMedia => ({
  id,
  mediaType: "image",
  url: `https://bucket.test/${id}.png`,
  categories,
});
const vid = (id: string, ...categories: string[]): PlanningMedia => ({
  id,
  mediaType: "video",
  url: `https://bucket.test/${id}.mp4`,
  categories,
});
const ctx = (media: readonly PlanningMedia[]): BlitzPlanningContext => ({
  activeAngleIds: [],
  influencers: [],
  bank: buildMediaBank(media, []),
  angleTitles: new Map(),
  influencerNames: new Map(),
});

describe("máquinas de estados (FR-150, P3-AUTO-001)", () => {
  it("el ciclo de vida normativo es un camino válido", () => {
    const path = [
      "DRAFT",
      "GENERATING",
      "REVIEW",
      "BUILDING",
      "ACTIVE",
      "COMPLETED",
    ] as const;
    for (let i = 1; i < path.length; i += 1) {
      expect(canTransitionAutomation(path[i - 1]!, path[i]!)).toBe(true);
    }
  });

  it("no se saltea la revisión ni se vuelve atrás", () => {
    expect(canTransitionAutomation("GENERATING", "BUILDING")).toBe(false);
    expect(canTransitionAutomation("DRAFT", "BUILDING")).toBe(false);
    expect(canTransitionAutomation("REVIEW", "DRAFT")).toBe(false);
    expect(canTransitionAutomation("ACTIVE", "REVIEW")).toBe(false);
    // Launch no es reversible por edición: después sólo cancelar.
    expect(canTransitionAutomation("BUILDING", "REVIEW")).toBe(false);
  });

  it("los terminales no salen a ningún lado", () => {
    for (const to of AUTOMATION_STATUSES) {
      expect(canTransitionAutomation("COMPLETED", to)).toBe(false);
      expect(canTransitionAutomation("CANCELLED", to)).toBe(false);
      expect(canTransitionAutomation("FAILED", to)).toBe(false);
    }
  });

  it("slot: generación, re-roll, build y cancel", () => {
    expect(canTransitionSlot("PENDING_GEN", "GENERATING")).toBe(true);
    expect(canTransitionSlot("GENERATING", "READY")).toBe(true);
    expect(canTransitionSlot("GENERATING", "FAILED_GEN")).toBe(true);
    expect(canTransitionSlot("READY", "REROLLING")).toBe(true);
    expect(canTransitionSlot("FAILED_GEN", "REROLLING")).toBe(true);
    expect(canTransitionSlot("REROLLING", "READY")).toBe(true);
    expect(canTransitionSlot("READY", "QUEUED_BUILD")).toBe(true);
    expect(canTransitionSlot("QUEUED_BUILD", "BUILDING")).toBe(true);
    expect(canTransitionSlot("BUILDING", "SCHEDULED")).toBe(true);
    expect(canTransitionSlot("SCHEDULED", "CANCELLED")).toBe(true);
    // Un slot que falló la generación no produce post.
    expect(canTransitionSlot("FAILED_GEN", "QUEUED_BUILD")).toBe(false);
    expect(canTransitionSlot("SCHEDULED", "READY")).toBe(false);
    for (const to of AUTOMATION_SLOT_STATUSES) {
      expect(canTransitionSlot("FAILED", to)).toBe(false);
      expect(canTransitionSlot("CANCELLED", to)).toBe(false);
    }
  });

  it("delete se rechaza en BUILDING y ACTIVE (F-219)", () => {
    expect(canDeleteAutomation("BUILDING")).toBe(false);
    expect(canDeleteAutomation("ACTIVE")).toBe(false);
    for (const s of ["DRAFT", "REVIEW", "COMPLETED", "CANCELLED", "FAILED"] as const)
      expect(canDeleteAutomation(s)).toBe(true);
  });
});

describe("prefsSnapshot congelado (F-212, P3-AUTO-003)", () => {
  it("es una copia: mutar las prefs de la marca no cambia la campaña", () => {
    const brand = {
      ...brandPrefs({ angleWeights: { a1: 100 } }),
    } as BlitzPreferences & { angleWeights: Record<string, number> };
    const snapshot = buildPrefsSnapshot(brand);
    (brand.angleWeights as Record<string, number>)["a1"] = 0;
    (brand as { slideshowWeight: number }).slideshowWeight = 0;
    expect(snapshot.angleWeights["a1"]).toBe(100);
    expect(snapshot.slideshowWeight).toBe(25);
  });

  it("los overrides del wizard pisan a la marca, y el patch conserva los temas", () => {
    const snapshot = buildPrefsSnapshot(brandPrefs(), {
      slideshowWeight: 0,
      wallOfTextWeight: 100,
      greenScreenWeight: 0,
      videoHookWeight: 0,
      topics: ["lunes"],
    });
    expect(campaignContentTypes(snapshot)).toEqual(["wall-of-text"]);
    const patched = patchPrefsSnapshot(snapshot, { remixPercentage: 30 });
    expect(patched.topics).toEqual(["lunes"]);
    expect(patched.remixPercentage).toBe(30);
  });

  it("el mix suma 100 o 0; cualquier otra cosa se rechaza", () => {
    expect(() =>
      buildPrefsSnapshot(brandPrefs(), { slideshowWeight: 10, wallOfTextWeight: 10 }),
    ).toThrow(DomainError);
    expect(() =>
      buildPrefsSnapshot(brandPrefs(), {
        slideshowWeight: 0,
        wallOfTextWeight: 0,
        greenScreenWeight: 0,
        videoHookWeight: 0,
      }),
    ).not.toThrow();
  });

  it("se lee de vuelta del jsonb, y uno ilegible es null (no defaults inventados)", () => {
    const snapshot = buildPrefsSnapshot(brandPrefs(), { topics: ["café"] });
    expect(parsePrefsSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    expect(parsePrefsSnapshot({ slideshowWeight: 100 })).toBeNull();
    expect(parsePrefsSnapshot(null)).toBeNull();
  });
});

describe("configuración (F-211)", () => {
  it("rangos de DATA-021", () => {
    const ok = {
      perAccountPerDay: 2,
      durationWeeks: 4,
      timezone: "UTC",
      postingTimes: null,
    };
    expect(() => assertValidSchedulingConfig(ok)).not.toThrow();
    expect(() => assertValidSchedulingConfig({ ...ok, perAccountPerDay: 4 })).toThrow();
    expect(() => assertValidSchedulingConfig({ ...ok, durationWeeks: 5 })).toThrow();
    expect(() => assertValidSchedulingConfig({ ...ok, timezone: "Mars/Base" })).toThrow();
    expect(() =>
      assertValidSchedulingConfig({ ...ok, postingTimes: ["25:00"] }),
    ).toThrow();
    expect(automationSlotCount({ perAccountPerDay: 2, durationWeeks: 4 })).toBe(56);
  });

  it("una cuenta por red, y la conexión tiene que ser de la marca y de esa red", () => {
    const connections = [
      { id: "c-ig", platform: "instagram", active: true },
      { id: "c-tt", platform: "tiktok", active: false },
    ];
    expect(
      accountProblems(
        [
          oauth("instagram", "c-ig"),
          oauth("instagram", "c-ig"),
          oauth("tiktok", "c-tt"),
          oauth("x", "c-nope"),
          oauth("youtube", "c-ig"),
        ],
        connections,
      ).map((p) => p.kind),
    ).toEqual([
      "duplicate_platform",
      "connection_inactive",
      "connection_not_found",
      "connection_platform_mismatch",
    ]);
    expect(accountProblems([{ platform: "x", accountType: "planned" }], [])).toEqual([]);
  });
});

describe("reglas duras de generación (FR-150, AI-012)", () => {
  const all = ["slideshow", "wall-of-text", "green-screen", "video-hook"] as const;
  const snapshot = (over: Partial<AutomationPrefsSnapshot> = {}) =>
    ({ ...buildPrefsSnapshot(brandPrefs()), ...over }) as AutomationPrefsSnapshot;

  it("todos los pesos en 0 → AUTOMATION_NO_CONTENT_TYPE_SELECTED", () => {
    const blocked = () =>
      assertGenerationAllowed({
        accounts: [oauth("instagram")],
        prefs: snapshot({
          slideshowWeight: 0,
          wallOfTextWeight: 0,
          greenScreenWeight: 0,
          videoHookWeight: 0,
        }),
        availableFormats: all,
      });
    expect(blocked).toThrow(AutomationGenerationBlocked);
    try {
      blocked();
    } catch (e) {
      expect((e as AutomationGenerationBlocked).code).toBe(
        "AUTOMATION_NO_CONTENT_TYPE_SELECTED",
      );
    }
  });

  it("P3-AUTO-011: un destino YouTube con slideshowWeight > 0 bloquea la generación", () => {
    let code: string | null = null;
    try {
      assertGenerationAllowed({
        accounts: [oauth("instagram"), oauth("youtube")],
        prefs: snapshot(),
        availableFormats: all,
      });
    } catch (e) {
      code = (e as AutomationGenerationBlocked).code;
    }
    expect(code).toBe("AUTOMATION_YOUTUBE_REQUIRES_NO_SLIDESHOW");
    expect(() =>
      assertGenerationAllowed({
        accounts: [oauth("youtube")],
        prefs: snapshot({
          slideshowWeight: 0,
          wallOfTextWeight: 50,
          greenScreenWeight: 50,
          videoHookWeight: 0,
        }),
        availableFormats: all,
      }),
    ).not.toThrow();
  });

  it("video-hook con peso y sin demo video → AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO", () => {
    let code: string | null = null;
    try {
      assertGenerationAllowed({
        accounts: [oauth("instagram")],
        prefs: snapshot(),
        availableFormats: ["slideshow", "wall-of-text", "green-screen"],
      });
    } catch (e) {
      code = (e as AutomationGenerationBlocked).code;
    }
    expect(code).toBe("AUTOMATION_VIDEO_HOOK_NEEDS_DEMO_VIDEO");
  });

  it("P3-AUTO-005: un tipo con peso 0 sin media NO bloquea (está excluido)", () => {
    expect(() =>
      assertGenerationAllowed({
        accounts: [oauth("instagram")],
        prefs: snapshot({
          slideshowWeight: 0,
          wallOfTextWeight: 100,
          greenScreenWeight: 0,
          videoHookWeight: 0,
        }),
        availableFormats: ["wall-of-text"],
      }),
    ).not.toThrow();
  });

  it("re-roll: no se puede forzar un tipo en 0 ni slideshow con YouTube", () => {
    const prefs = snapshot({
      slideshowWeight: 0,
      wallOfTextWeight: 100,
      greenScreenWeight: 0,
      videoHookWeight: 0,
    });
    expect(rerollTypeProblem("green-screen", prefs, [oauth("instagram")])).toBe(
      "excluded_type",
    );
    expect(rerollTypeProblem("slideshow", snapshot(), [oauth("youtube")])).toBe(
      "youtube_slideshow",
    );
    expect(rerollTypeProblem("wall-of-text", prefs, [oauth("youtube")])).toBeNull();
  });

  it("los temas se reparten en ronda", () => {
    const prefs = snapshot({ topics: ["a", "b"] });
    expect([0, 1, 2].map((i) => topicForSlot(prefs, i))).toEqual(["a", "b", "a"]);
    expect(topicForSlot(snapshot(), 3)).toBeUndefined();
  });
});

describe("reparto de tipos (AI-012 — peso 0 nunca es fallback)", () => {
  it("mayor resto exacto: 14 slots 50/50 son 7 y 7", () => {
    const counts = apportionContentTypes(14, {
      slideshow: 50,
      "wall-of-text": 50,
      "green-screen": 0,
      "video-hook": 0,
    });
    expect(counts).toEqual({
      slideshow: 7,
      "wall-of-text": 7,
      "green-screen": 0,
      "video-hook": 0,
    });
  });

  it("suma n siempre y un tipo en 0 nunca aparece", () => {
    for (const n of [1, 2, 7, 13, 21, 84]) {
      const types = assignContentTypes(n, {
        slideshow: 45,
        "wall-of-text": 45,
        "green-screen": 10,
        "video-hook": 0,
      });
      expect(types).toHaveLength(n);
      expect(types).not.toContain("video-hook");
    }
  });

  it("intercala en vez de agrupar", () => {
    expect(
      assignContentTypes(4, {
        slideshow: 50,
        "wall-of-text": 50,
        "green-screen": 0,
        "video-hook": 0,
      }),
    ).toEqual(["slideshow", "wall-of-text", "slideshow", "wall-of-text"]);
  });

  it("planAutomationSlot no cambia de tipo si al forzado le falta media", () => {
    const snapshot = buildPrefsSnapshot(brandPrefs());
    const onlyImages = ctx([img("s1", "slideshow-image"), img("s2", "slideshow-image")]);
    const hook = planAutomationSlot(
      scriptedRng([0.1]),
      snapshot,
      onlyImages,
      "video-hook",
    );
    expect(hook).toMatchObject({ ok: false, failureReason: "no_demo_video" });
    const wall = planAutomationSlot(
      scriptedRng([0.1]),
      snapshot,
      onlyImages,
      "wall-of-text",
    );
    expect(wall).toMatchObject({ ok: false, failureReason: null, errorCode: "no_media" });
    const slide = planAutomationSlot(
      scriptedRng([0.1]),
      snapshot,
      onlyImages,
      "slideshow",
    );
    expect(slide.ok && slide.planned.plan.contentType).toBe("slideshow");
  });

  it("con el tipo forzado el plan sale de ese tipo aunque el mix pese otro", () => {
    const snapshot = buildPrefsSnapshot(brandPrefs(), {
      slideshowWeight: 90,
      wallOfTextWeight: 10,
      greenScreenWeight: 0,
      videoHookWeight: 0,
    });
    const bank = ctx([img("s1", "slideshow-image"), vid("bg", "background-video")]);
    const out = planAutomationSlot(scriptedRng([0.01]), snapshot, bank, "wall-of-text");
    expect(out.ok && out.planned.plan.contentType).toBe("wall-of-text");
  });
});

describe("grilla de horarios (F-211)", () => {
  const start = { year: 2026, month: 10, day: 5 }; // lunes
  const nowMs = Date.UTC(2026, 9, 1);

  it("perAccountPerDay × 7 × semanas, con los horarios de la estrategia", () => {
    const slots = planCampaignSchedule({
      seed: "a1",
      startDate: start,
      timezone: "America/Argentina/Buenos_Aires",
      durationWeeks: 1,
      perAccountPerDay: 2,
      postingTimes: null,
      strategyWindows: { mon: ["10:00", "20:00", "22:00"] },
      jitterMinutes: 0,
      nowMs,
    });
    expect(slots).toHaveLength(14);
    // Lunes: las dos primeras ventanas de la estrategia.
    expect(slots[0]!.atMs).toBe(
      zonedWallTimeToUtc(start, 10 * 60, "America/Argentina/Buenos_Aires"),
    );
    // Martes sin ventanas: los de relleno.
    expect(
      timesForDay({ year: 2026, month: 10, day: 6 }, 2, null, { mon: ["10:00"] }),
    ).toEqual([9 * 60, 13 * 60]);
  });

  it("jitter determinista: misma semilla, misma grilla", () => {
    const input = {
      seed: "abc",
      startDate: start,
      timezone: "UTC",
      durationWeeks: 1,
      perAccountPerDay: 1,
      postingTimes: ["09:00"],
      strategyWindows: {},
      jitterMinutes: 7,
      nowMs,
    };
    expect(planCampaignSchedule(input)).toEqual(planCampaignSchedule(input));
    for (const s of planCampaignSchedule(input)) {
      const base = Math.floor(s.atMs / 86_400_000) * 86_400_000 + 9 * 3_600_000;
      expect(Math.abs(s.atMs - base)).toBeLessThanOrEqual(7 * 60_000);
    }
  });

  it("no genera horarios vencidos", () => {
    const slots = planCampaignSchedule({
      seed: "x",
      startDate: start,
      timezone: "UTC",
      durationWeeks: 1,
      perAccountPerDay: 1,
      postingTimes: ["09:00"],
      strategyWindows: {},
      jitterMinutes: 0,
      nowMs: Date.UTC(2026, 9, 7, 12),
    });
    expect(slots.map((s) => s.localDay)).toEqual([
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
    ]);
  });
});

describe("dedup (P3-AUTO-006/007)", () => {
  it("normaliza acentos, mayúsculas, puntuación y emojis", () => {
    expect(normalizeForDedup("¡Café  de LUNES! ☕")).toBe("cafe de lunes");
    expect(dedupFingerprint("Café de lunes")).toBe(dedupFingerprint("cafe, de LUNES!!"));
  });

  it("idéntico y casi idéntico son duplicados; otro tema, no", () => {
    const corpus = [
      {
        text: "Los lunes empiezan mejor con un café de especialidad bien hecho",
        mediaKey: null,
      },
    ];
    expect(
      judgeDuplicate(
        {
          text: "los lunes empiezan mejor con un cafe de especialidad bien hecho!",
          mediaKey: null,
        },
        corpus,
      ).verdict,
    ).toBe("duplicate");
    expect(
      judgeDuplicate(
        {
          text: "Los lunes empiezan mejor con un café de especialidad bien hecho y medialunas",
          mediaKey: null,
        },
        corpus,
      ).verdict,
    ).toBe("duplicate");
    expect(
      judgeDuplicate(
        { text: "Tres errores comunes al moler granos en casa", mediaKey: null },
        corpus,
      ).verdict,
    ).toBe("unique");
  });

  it("borderline: decide la media", () => {
    const base = "cinco razones para probar nuestro cold brew este verano en la terraza";
    const variant = "cinco razones para probar nuestro cold brew esta semana con amigos";
    const corpus = [{ text: base, mediaKey: "m1" }];
    expect(judgeDuplicate({ text: variant, mediaKey: "m1" }, corpus).verdict).toBe(
      "duplicate",
    );
    expect(judgeDuplicate({ text: variant, mediaKey: "m2" }, corpus).verdict).toBe(
      "unique",
    );
  });

  it("un texto vacío nunca pasa", () => {
    expect(judgeDuplicate({ text: " !! ", mediaKey: null }, []).verdict).toBe(
      "duplicate",
    );
  });
});

describe("revisión (F-214)", () => {
  it("captions por defecto: YouTube título + cuerpo, LinkedIn sólo caption, X recortada", () => {
    const text = "Lunes de café. " + "x".repeat(400);
    const captions = defaultCaptions(text, ["youtube", "linkedin", "x"]);
    expect(captions.youtube?.caption).toBe("Lunes de café.");
    expect(captions.youtube?.description).toBe(text);
    expect(captions.linkedin?.description).toBeUndefined();
    expect([...(captions.x?.caption ?? "")].length).toBeLessThanOrEqual(280);
  });

  it("valida el mapa contra los destinos y los topes por red", () => {
    const problems = captionProblems(
      {
        youtube: { caption: "t".repeat(101), description: "ok" },
        linkedin: { caption: "hola", description: "no" },
        tiktok: { caption: "fuera" },
      },
      ["youtube", "linkedin"],
    ).map((p) => `${p.platform}:${p.kind}`);
    expect(problems).toEqual([
      "youtube:caption_too_long",
      "linkedin:description_not_supported",
      "tiktok:not_a_destination",
    ]);
  });

  it("los textos se editan con generatedText, y la cantidad es la del plan", () => {
    const data = {
      buildPlan: {
        version: 1 as const,
        media: {
          format: "slideshow" as const,
          slides: [
            { mediaId: "a", url: "https://x/a" },
            { mediaId: "b", url: "https://x/b" },
          ],
        },
        texts: ["uno", "dos"],
      },
      aiExplanation: "",
      angleId: null,
      influencerId: null,
      textStylePresetId: null,
      topic: null,
      dedup: { fingerprint: "", score: 0 },
    };
    const edited = applyTextEdit(data, [" Uno nuevo ", "Dos"]);
    expect(edited.generatedText).toBe("Uno nuevo\n\nDos");
    expect(edited.data.buildPlan.texts).toEqual(["Uno nuevo", "Dos"]);
    expect(() => applyTextEdit(data, ["solo uno"])).toThrow(DomainError);
  });
});

describe("launchValidation (F-216) — enumera TODOS los gates", () => {
  const nowMs = Date.UTC(2026, 9, 1, 12);
  const base = (over: Partial<LaunchGateInput> = {}): LaunchGateInput => ({
    status: "REVIEW",
    slots: [
      {
        id: "s1",
        status: "READY",
        contentType: "wall-of-text",
        scheduledAtMs: nowMs + 86_400_000,
      },
    ],
    accounts: [oauth("instagram", "c1")],
    connections: [{ id: "c1", platform: "instagram", active: true }],
    aiContentDisclaimer: false,
    nowMs,
    brandTimezone: "UTC",
    dailyCaps: {},
    occupied: [],
    saves: { policy: "unlimited" },
    ...over,
  });

  it("todo en orden → ok", () => {
    const v = evaluateLaunchGates(base());
    expect(v.ok).toBe(true);
    expect(v.summary).toEqual({
      readySlots: 1,
      destinations: 1,
      posts: 1,
      contentSaves: 1,
    });
  });

  it("junta varios gates a la vez", () => {
    const tomorrow = nowMs + 86_400_000;
    const v = evaluateLaunchGates(
      base({
        slots: [
          {
            id: "a",
            status: "READY",
            contentType: "slideshow",
            scheduledAtMs: nowMs - 1,
          },
          {
            id: "b",
            status: "REROLLING",
            contentType: "wall-of-text",
            scheduledAtMs: tomorrow,
          },
          {
            id: "c",
            status: "READY",
            contentType: "wall-of-text",
            scheduledAtMs: tomorrow,
          },
        ],
        accounts: [oauth("youtube", "c-yt"), { platform: "x", accountType: "planned" }],
        connections: [{ id: "c-yt", platform: "youtube", active: false }],
        aiContentDisclaimer: true,
        occupied: [
          { network: "x", atMs: tomorrow + 1 },
          { network: "x", atMs: tomorrow + 2 },
          { network: "x", atMs: tomorrow + 3 },
        ],
        saves: { policy: "enforced", remaining: 1 },
      }),
    );
    expect(v.ok).toBe(false);
    expect(v.gates.map((g) => g.code)).toEqual([
      "content_generating",
      "destination_unavailable",
      "schedule_in_past",
      "posting_limit_conflicts",
      "youtube_slideshow",
      "content_budget",
      "ai_label_unsupported",
    ]);
  });

  it("modo personal: el presupuesto de saves nunca bloquea", () => {
    const v = evaluateLaunchGates(base({ saves: { policy: "unlimited" } }));
    expect(v.gates.find((g) => g.code === "content_budget")).toBeUndefined();
  });

  it("sin nada listo, sin destinos, y fuera de REVIEW", () => {
    const v = evaluateLaunchGates(
      base({ status: "GENERATING", slots: [], accounts: [] }),
    );
    expect(v.gates.map((g) => g.code)).toEqual([
      "not_in_review",
      "no_ready_slots",
      "no_destinations",
    ]);
  });
});

describe("después del launch (F-217/F-219)", () => {
  it("slot según su pieza", () => {
    expect(slotStatusForContent("QUEUED_BUILD", "BUILDING")).toBe("BUILDING");
    expect(slotStatusForContent("BUILDING", "CREATED")).toBe("SCHEDULED");
    expect(slotStatusForContent("BUILDING", "FAILED")).toBe("FAILED");
    expect(slotStatusForContent("QUEUED_BUILD", null)).toBe("FAILED");
    expect(slotStatusForContent("CANCELLED", "CREATED")).toBe("CANCELLED");
  });

  it("campaña BUILDING → ACTIVE / FAILED", () => {
    expect(automationStatusAfterBuilds("BUILDING", ["SCHEDULED", "BUILDING"])).toBe(
      "BUILDING",
    );
    expect(automationStatusAfterBuilds("BUILDING", ["SCHEDULED", "FAILED"])).toBe(
      "ACTIVE",
    );
    expect(automationStatusAfterBuilds("BUILDING", ["FAILED", "CANCELLED"])).toBe(
      "FAILED",
    );
  });

  it("COMPLETED sólo sin posts pendientes y pasada la gracia", () => {
    const last = Date.UTC(2026, 9, 10);
    expect(
      isAutomationComplete({
        status: "ACTIVE",
        lastSlotAtMs: last,
        pendingPosts: 0,
        nowMs: last + 1,
      }),
    ).toBe(false);
    expect(
      isAutomationComplete({
        status: "ACTIVE",
        lastSlotAtMs: last,
        pendingPosts: 1,
        nowMs: last + 2 * 86_400_000,
      }),
    ).toBe(false);
    expect(
      isAutomationComplete({
        status: "ACTIVE",
        lastSlotAtMs: last,
        pendingPosts: 0,
        nowMs: last + 2 * 86_400_000,
      }),
    ).toBe(true);
  });

  it("cancel deja vivo lo publicado", () => {
    expect(slotStatusOnCancel("SCHEDULED", true)).toBe("SCHEDULED");
    expect(slotStatusOnCancel("SCHEDULED", false)).toBe("CANCELLED");
    expect(slotStatusOnCancel("READY", false)).toBe("CANCELLED");
    expect(slotStatusOnCancel("FAILED", false)).toBe("FAILED");
  });
});

describe("jobs: la cola se comparte con el piloto sin romperlo", () => {
  const c = "11111111-1111-4111-8111-111111111111";
  const a = "22222222-2222-4222-8222-222222222222";
  const s = "33333333-3333-4333-8333-333333333333";

  it("sólo `automationId` distingue una campaña", () => {
    expect(isAutomationCampaignPayload({})).toBe(false);
    expect(isAutomationCampaignPayload({ companyId: c })).toBe(false);
    expect(isAutomationCampaignPayload(null)).toBe(false);
    expect(isAutomationCampaignPayload({ companyId: c, automationId: a })).toBe(true);
  });

  it("parsea generate y re-roll, y rechaza lo malformado", () => {
    expect(parseAutomationCampaignJob({ companyId: c, automationId: a })).toEqual({
      kind: "generate",
      companyId: c,
      automationId: a,
    });
    expect(
      parseAutomationCampaignJob({
        companyId: c,
        automationId: a,
        slotId: s,
        contentType: "green-screen",
      }),
    ).toMatchObject({ kind: "reroll", contentType: "green-screen" });
    expect(parseAutomationCampaignJob({ companyId: c, automationId: "x" })).toBeNull();
    expect(
      parseAutomationCampaignJob({
        companyId: c,
        automationId: a,
        slotId: s,
        contentType: "custom",
      }),
    ).toBeNull();
  });

  it("build-schedule: {} es el barrido", () => {
    expect(parseAutomationBuildJob({})).toEqual({ kind: "sweep" });
    expect(parseAutomationBuildJob({ companyId: c, automationId: a })).toMatchObject({
      kind: "automation",
    });
    expect(parseAutomationBuildJob({ companyId: c })).toBeNull();
  });
});
