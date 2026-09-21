import { describe, expect, it } from "vitest";
import {
  BATCH_POST_IDS_MAX,
  INSTAGRAM_CAPTION_MAX,
  TIKTOK_DESCRIPTION_MAX,
  TIKTOK_SLOW_LANE_RETRY_HOURS,
  TIKTOK_TITLE_MAX,
  WARMED_MAX_SCHEDULE_DAYS_AHEAD,
  cancelPostsRequestSchema,
  deletePostsRequestSchema,
  instagramScheduleTargetSchema,
  listPostsQuerySchema,
  postStatusFilterSchema,
  scheduleContentRequestSchema,
  tiktokScheduleTargetSchema,
} from "./posts.js";

describe("límites de copy por plataforma · F-153 · PRD:621", () => {
  it("Instagram caption ≤ 2200 · PRD:1351", () => {
    expect(INSTAGRAM_CAPTION_MAX).toBe(2200);
    expect(
      instagramScheduleTargetSchema.parse({
        platform: "instagram",
        caption: "c".repeat(2200),
      }),
    ).toBeTruthy();
    expect(() =>
      instagramScheduleTargetSchema.parse({
        platform: "instagram",
        caption: "c".repeat(2201),
      }),
    ).toThrow();
  });

  it("TikTok title ≤ 90 · INT-001 · PRD:2444", () => {
    expect(TIKTOK_TITLE_MAX).toBe(90);
    expect(
      tiktokScheduleTargetSchema.parse({ platform: "tiktok", title: "t".repeat(90) }),
    ).toBeTruthy();
    expect(() =>
      tiktokScheduleTargetSchema.parse({ platform: "tiktok", title: "t".repeat(91) }),
    ).toThrow();
  });

  it("TikTok description ≤ 4000 · INT-001 · PRD:2444", () => {
    expect(TIKTOK_DESCRIPTION_MAX).toBe(4000);
    expect(
      tiktokScheduleTargetSchema.parse({
        platform: "tiktok",
        description: "d".repeat(4000),
      }),
    ).toBeTruthy();
    expect(() =>
      tiktokScheduleTargetSchema.parse({
        platform: "tiktok",
        description: "d".repeat(4001),
      }),
    ).toThrow();
  });
});

describe("cuenta destino · FR-060 · PRD:1374", () => {
  it("connectionId y warmedAccountId son mutuamente excluyentes", () => {
    expect(() =>
      instagramScheduleTargetSchema.parse({
        platform: "instagram",
        connectionId: "con_1",
        warmedAccountId: "wa_1",
      }),
    ).toThrow();
  });

  it("cualquiera de los dos por separado es válido", () => {
    expect(
      instagramScheduleTargetSchema.parse({
        platform: "instagram",
        connectionId: "con_1",
      }),
    ).toBeTruthy();
    expect(
      instagramScheduleTargetSchema.parse({
        platform: "instagram",
        warmedAccountId: "wa_1",
      }),
    ).toBeTruthy();
  });
});

describe("reglas de TikTok · FR-060 · PRD:1375 y PRD:1390", () => {
  it("postingMode es sólo OAuth: se rechaza junto a warmedAccountId", () => {
    expect(() =>
      tiktokScheduleTargetSchema.parse({
        platform: "tiktok",
        warmedAccountId: "wa_1",
        postingMode: "direct",
        privacyLevel: "PUBLIC_TO_EVERYONE",
      }),
    ).toThrow();
  });

  it("postingMode 'direct' exige privacyLevel (privacy_level_required)", () => {
    expect(() =>
      tiktokScheduleTargetSchema.parse({ platform: "tiktok", postingMode: "direct" }),
    ).toThrow();
    expect(
      tiktokScheduleTargetSchema.parse({
        platform: "tiktok",
        postingMode: "direct",
        privacyLevel: "SELF_ONLY",
      }),
    ).toBeTruthy();
  });

  it("privacyLevel sin 'direct' se rechaza (privacy_level_not_allowed_without_direct_mode)", () => {
    expect(() =>
      tiktokScheduleTargetSchema.parse({
        platform: "tiktok",
        postingMode: "inbox",
        privacyLevel: "PUBLIC_TO_EVERYONE",
      }),
    ).toThrow();
  });

  it("un privacy level no reconocido se rechaza (invalid_privacy_level)", () => {
    expect(() =>
      tiktokScheduleTargetSchema.parse({
        platform: "tiktok",
        postingMode: "direct",
        privacyLevel: "FRIENDS_ONLY",
      }),
    ).toThrow();
  });
});

describe("lotes de posts · NFR-012 · PRD:2962", () => {
  it("máximo 100 ids por llamada", () => {
    expect(BATCH_POST_IDS_MAX).toBe(100);
    const hundred = Array.from({ length: 100 }, (_, i) => `post_${i}`);
    expect(cancelPostsRequestSchema.parse({ postIds: hundred }).postIds).toHaveLength(
      100,
    );
    expect(() =>
      cancelPostsRequestSchema.parse({ postIds: [...hundred, "post_100"] }),
    ).toThrow();
  });

  it("los duplicados se deduplican ANTES de aplicar el cap", () => {
    // 150 ids con 60 repetidos → 90 únicos: la llamada es válida.
    const ninety = Array.from({ length: 90 }, (_, i) => `post_${i}`);
    const withDupes = [...ninety, ...ninety.slice(0, 60)];
    expect(withDupes).toHaveLength(150);
    expect(deletePostsRequestSchema.parse({ postIds: withDupes }).postIds).toHaveLength(
      90,
    );
  });

  it("un lote vacío se rechaza", () => {
    expect(() => cancelPostsRequestSchema.parse({ postIds: [] })).toThrow();
  });
});

describe("programación", () => {
  it("scheduledAtUtc y al menos un target son obligatorios", () => {
    expect(() => scheduleContentRequestSchema.parse({ targets: [] })).toThrow();
    expect(() =>
      scheduleContentRequestSchema.parse({ scheduledAtUtc: 1, targets: [] }),
    ).toThrow();
    expect(
      scheduleContentRequestSchema.parse({
        scheduledAtUtc: 1_700_000_000_000,
        targets: [{ platform: "instagram", caption: "hola" }],
      }).targets,
    ).toHaveLength(1);
  });

  it("acepta varios destinos: un Post por (contenido × plataforma × cuenta) · PRD:1370", () => {
    const parsed = scheduleContentRequestSchema.parse({
      scheduledAtUtc: 1_700_000_000_000,
      targets: [
        { platform: "instagram", caption: "hola" },
        { platform: "tiktok", title: "t", description: "d" },
        { platform: "youtube", caption: "título", description: "cuerpo" },
      ],
      enableCaptionGeneration: true,
    });
    expect(parsed.targets).toHaveLength(3);
  });

  it("reddit no admite warmedAccountId: la publicación warmed es sólo tiktok/instagram · PRD:1374", () => {
    expect(() =>
      scheduleContentRequestSchema.parse({
        scheduledAtUtc: 1,
        targets: [{ platform: "reddit", warmedAccountId: "wa_1" }],
      }),
    ).toThrow();
  });

  it("una plataforma que el PRD no lista para posts v1 se rechaza", () => {
    expect(() =>
      scheduleContentRequestSchema.parse({
        scheduledAtUtc: 1,
        targets: [{ platform: "linkedin", caption: "hola" }],
      }),
    ).toThrow();
  });
});

describe("otros números de publicación", () => {
  it("warmed: máximo 30 días de antelación · FR-060 · PRD:1394", () => {
    expect(WARMED_MAX_SCHEDULE_DAYS_AHEAD).toBe(30);
  });

  it("el carril lento de TikTok se reintenta hasta 72 h · NFR-015 · PRD:2965", () => {
    expect(TIKTOK_SLOW_LANE_RETRY_HOURS).toBe(72);
  });
});

describe("listado de posts · §12 · PRD:2720", () => {
  it("el filtro de status es una lista separada por comas", () => {
    expect(listPostsQuerySchema.parse({ status: "SCHEDULED,POSTED" }).status).toEqual([
      "SCHEDULED",
      "POSTED",
    ]);
  });

  it("el filtro que enumera el PRD NO incluye CANCELLED, aunque sea un estado válido", () => {
    expect(postStatusFilterSchema.options).toHaveLength(9);
    expect(postStatusFilterSchema.options).not.toContain("CANCELLED");
    expect(() => listPostsQuerySchema.parse({ status: "CANCELLED" })).toThrow();
  });
});
