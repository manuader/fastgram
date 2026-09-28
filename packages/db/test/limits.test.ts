/**
 * Los números del PRD, fijados.
 *
 * IMPL §4: *"toda regla de negocio con un número en el PRD lleva un test que fija ese
 * número. […] Esos tests son la documentación ejecutable del PRD."*
 *
 * Este archivo **no** prueba lógica: prueba que nadie cambió un cap de un producto
 * leyendo sólo el código. Si un número tiene que cambiar, primero cambia el PRD y
 * después este test — en ese orden.
 */

import { describe, expect, it } from "vitest";

import {
  AUTOMATION_LIMITS,
  BATCH_LIMITS,
  BLITZ_PREFERENCES_LIMITS,
  BRAND_SOURCE_LIMITS,
  CONTENT_ANGLE_LIMITS,
  CONTENT_LIMITS,
  CONTENT_TEXT_BOX,
  INFLUENCER_LIMITS,
  PAGINATION,
  PLATFORM_COPY_LIMITS,
  UPLOAD_LIMITS,
} from "../src/limits";
import {
  AUTOMATION_SLOT_STATUS,
  AUTOMATION_STATUS,
  BRAND_SOURCE_TYPE,
  CONTENT_STATUS,
  CONTENT_TYPE,
  POST_STATUS,
  PRIVACY_LEVEL,
  SUGGESTION_CONTENT_TYPE,
} from "../src/schema/enums";

describe("caps y rangos del PRD", () => {
  it("DATA-005 · ContentAngle", () => {
    expect(CONTENT_ANGLE_LIMITS.maxPerWorkspace).toBe(100);
    expect(CONTENT_ANGLE_LIMITS.maxPerInfluencer).toBe(10);
    expect(CONTENT_ANGLE_LIMITS.titleMaxChars).toBe(200);
    expect(CONTENT_ANGLE_LIMITS.descriptionMaxChars).toBe(2000);
    expect(CONTENT_ANGLE_LIMITS.targetAudienceMaxChars).toBe(500);
  });

  it("DATA-008 · Content y FR-070 · slideshow", () => {
    expect(CONTENT_LIMITS.generatedTextMaxChars).toBe(2000);
    expect(CONTENT_LIMITS.maxSlidesPerSlideshow).toBe(20);
  });

  it("DATA-009 · ContentTextBox", () => {
    expect(CONTENT_TEXT_BOX.textMaxChars).toBe(5000);
    expect([CONTENT_TEXT_BOX.positionMin, CONTENT_TEXT_BOX.positionMax]).toEqual([
      0, 100,
    ]);
    expect([CONTENT_TEXT_BOX.widthPercentMin, CONTENT_TEXT_BOX.widthPercentMax]).toEqual([
      25, 100,
    ]);
    expect([CONTENT_TEXT_BOX.fontSizeMin, CONTENT_TEXT_BOX.fontSizeMax]).toEqual([8, 72]);
    expect([CONTENT_TEXT_BOX.strokeWidthMin, CONTENT_TEXT_BOX.strokeWidthMax]).toEqual([
      0, 8,
    ]);
    expect([
      CONTENT_TEXT_BOX.backgroundOpacityMin,
      CONTENT_TEXT_BOX.backgroundOpacityMax,
    ]).toEqual([0, 1]);
  });

  it("DATA-013 · Influencer", () => {
    expect(INFLUENCER_LIMITS.maxActivePerWorkspace).toBe(50);
    expect([INFLUENCER_LIMITS.ageMin, INFLUENCER_LIMITS.ageMax]).toEqual([18, 60]);
    expect([INFLUENCER_LIMITS.progressMin, INFLUENCER_LIMITS.progressMax]).toEqual([
      0, 100,
    ]);
  });

  it("DATA-006 · los pesos de formato suman 100", () => {
    expect(BLITZ_PREFERENCES_LIMITS.formatWeightsSum).toBe(100);
  });

  it("DATA-021 · Automation", () => {
    expect(AUTOMATION_LIMITS.nameMaxChars).toBe(100);
    expect([
      AUTOMATION_LIMITS.perAccountPerDayMin,
      AUTOMATION_LIMITS.perAccountPerDayMax,
    ]).toEqual([1, 3]);
    expect([
      AUTOMATION_LIMITS.durationWeeksMin,
      AUTOMATION_LIMITS.durationWeeksMax,
    ]).toEqual([1, 4]);
  });

  it("DATA-031 · §9.14 · BrandSource", () => {
    expect(BRAND_SOURCE_LIMITS.maxPerWorkspace).toBe(5);
    expect(BRAND_SOURCE_LIMITS.defaultReanalysesPerDay).toBe(3);
    expect(BRAND_SOURCE_LIMITS.defaultItemsAnalysedPerSource).toBe(24);
    expect(BRAND_SOURCE_LIMITS.staleAfterDays).toBe(90);
  });

  it("§9.10 · paginación por cursor", () => {
    expect(PAGINATION.limitMin).toBe(1);
    expect(PAGINATION.limitMax).toBe(100);
    expect(PAGINATION.limitDefault).toBe(20);
  });

  it("NFR-012 · lotes", () => {
    expect(BATCH_LIMITS.maxIdsPerCall).toBe(100);
  });

  it("FR-060 · límites de copy por plataforma", () => {
    expect(PLATFORM_COPY_LIMITS.instagramCaptionMaxChars).toBe(2200);
    expect(PLATFORM_COPY_LIMITS.tiktokTitleMaxChars).toBe(90);
    expect(PLATFORM_COPY_LIMITS.tiktokDescriptionMaxChars).toBe(4000);
  });

  it("§9.8 · uploads", () => {
    expect(UPLOAD_LIMITS.imageMaxBytes).toBe(10 * 1024 * 1024);
    expect(UPLOAD_LIMITS.videoMaxBytes).toBe(50 * 1024 * 1024);
    expect(UPLOAD_LIMITS.influencerBaseImageMaxBytes).toBe(10 * 1024 * 1024);
    expect(UPLOAD_LIMITS.imageContentTypes).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    expect(UPLOAD_LIMITS.videoContentTypes).toEqual(["video/mp4", "video/quicktime"]);
  });
});

describe("enums literales del PRD", () => {
  it("DATA-008 · Content.status y Content.type", () => {
    expect(CONTENT_STATUS).toEqual(["BUILDING", "CREATED", "FAILED"]);
    expect(CONTENT_TYPE).toEqual([
      "slideshow",
      "wall-of-text",
      "green-screen",
      "video-hook",
      "custom",
      // PRD §2.7 D-20 (sprint 9, migración 0038): el formato `reel`.
      "reel",
    ]);
  });

  it("FR-050 · una sugerencia nunca es `custom`", () => {
    expect(SUGGESTION_CONTENT_TYPE).toEqual([
      "slideshow",
      "wall-of-text",
      "green-screen",
      "video-hook",
      // Sprint 9 (U, `PU-S9-014`): los reels del planificador semanal.
      "reel",
    ]);
    expect(SUGGESTION_CONTENT_TYPE).not.toContain("custom");
  });

  it("FR-060 · máquina de estados de Post (enum normativo)", () => {
    expect(POST_STATUS).toEqual([
      "BUILDING",
      "CREATED",
      "SCHEDULED",
      "UPLOADING_TO_TIKTOK",
      "IN_USER_INBOX",
      "POSTED",
      "FAILED",
      "DELETED",
      "AWAITING_RECONNECT",
      "CANCELLED",
    ]);
  });

  it("DATA-020 · privacy levels de TikTok", () => {
    expect(PRIVACY_LEVEL).toEqual([
      "PUBLIC_TO_EVERYONE",
      "MUTUAL_FOLLOW_FRIENDS",
      "FOLLOWER_OF_CREATOR",
      "SELF_ONLY",
    ]);
  });

  it("DATA-021 / DATA-022 · estados de Automation y AutomationSlot", () => {
    expect(AUTOMATION_STATUS).toEqual([
      "DRAFT",
      "GENERATING",
      "REVIEW",
      "BUILDING",
      "ACTIVE",
      "COMPLETED",
      "CANCELLED",
      "FAILED",
    ]);
    expect(AUTOMATION_SLOT_STATUS).toEqual([
      "PENDING_GEN",
      "GENERATING",
      "READY",
      "REROLLING",
      "FAILED_GEN",
      "QUEUED_BUILD",
      "BUILDING",
      "SCHEDULED",
      "FAILED",
      "CANCELLED",
    ]);
  });

  it("DATA-031 · las 5 plataformas de `D-02` más website/other_url/manual", () => {
    expect(BRAND_SOURCE_TYPE).toEqual([
      "website",
      "instagram",
      "tiktok",
      "x",
      "youtube",
      "linkedin",
      "other_url",
      "manual",
    ]);
  });
});
