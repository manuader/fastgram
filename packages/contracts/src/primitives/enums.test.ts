import { describe, expect, it } from "vitest";
import {
  accountTypeSchema,
  aspectRatioSchema,
  audioLibrarySchema,
  blitzContentTypeSchema,
  captionAdjustmentReasonSchema,
  connectionStatusSchema,
  contentStatusSchema,
  contentTypeSchema,
  fontFamilySchema,
  FONT_WEIGHTS,
  genderFilterSchema,
  hexColorSchema,
  imageContentTypeSchema,
  imageMediaCategorySchema,
  influencerStatusSchema,
  instagramSlideshowFormatSchema,
  mediaOriginSchema,
  mediaSetKindSchema,
  mediaStatusSchema,
  mediaTypeSchema,
  platformSchema,
  postPlatformSchema,
  postStatusSchema,
  postingModeSchema,
  privacyLevelSchema,
  textAlignSchema,
  textBackgroundStyleSchema,
  textStylePresetSchema,
  tiktokSoundModeSchema,
  uploadReservationStateSchema,
  videoContentTypeSchema,
  videoMediaCategorySchema,
  warmedPlatformSchema,
} from "./enums.js";

describe("enums literales del PRD", () => {
  it("contentType · FR-050 Validation · PRD:1129", () => {
    expect(blitzContentTypeSchema.options).toEqual([
      "slideshow",
      "wall-of-text",
      "green-screen",
      "video-hook",
    ]);
  });

  it("un contentType no reconocido se rechaza → 400 bad_request · PRD:1129", () => {
    expect(() => blitzContentTypeSchema.parse("carousel")).toThrow();
    expect(() => blitzContentTypeSchema.parse("Slideshow")).toThrow(); // mayúscula ≠ literal
    expect(() => blitzContentTypeSchema.parse("wall_of_text")).toThrow(); // guion bajo ≠ guion
  });

  it("Content.type añade `custom` · DATA-008 · PRD:2075", () => {
    expect(contentTypeSchema.options).toEqual([
      "slideshow",
      "wall-of-text",
      "green-screen",
      "video-hook",
      "custom",
    ]);
  });

  it("aspectRatio · FR-050 Validation · PRD:1129", () => {
    expect(aspectRatioSchema.options).toEqual(["1:1", "4:5", "3:4", "9:16"]);
    expect(() => aspectRatioSchema.parse("16:9")).toThrow();
  });

  it("Content.status · DATA-008 · PRD:2076", () => {
    expect(contentStatusSchema.options).toEqual(["BUILDING", "CREATED", "FAILED"]);
  });

  it("Connection.platform · DATA-016 · PRD:2111 + D-09 (0015)", () => {
    expect(platformSchema.options).toEqual([
      "tiktok",
      "instagram",
      "youtube",
      "linkedin",
      "reddit",
      "x",
      "threads",
      "facebook",
    ]);
  });

  it("Post.platform · DATA-020 · PRD:2126 — sin linkedin (sólo en automations, que son MCP); x, threads y facebook de D-09", () => {
    expect(postPlatformSchema.options).toEqual([
      "tiktok",
      "instagram",
      "youtube",
      "reddit",
      "x",
      "threads",
      "facebook",
    ]);
  });

  it("warmed sólo tiktok e instagram · FR-130 · PRD:1705", () => {
    expect(warmedPlatformSchema.options).toEqual(["tiktok", "instagram"]);
    expect(() => warmedPlatformSchema.parse("youtube")).toThrow();
  });

  it("Connection.status · DATA-016 · PRD:2111", () => {
    expect(connectionStatusSchema.options).toEqual([
      "active",
      "expired",
      "paused",
      "revoked",
    ]);
  });

  it("accountType · DATA-020 · PRD:2127", () => {
    expect(accountTypeSchema.options).toEqual(["oauth", "warmed"]);
  });

  it("Post.status — los 10 estados normativos · FR-060 · PRD:1379", () => {
    expect(postStatusSchema.options).toEqual([
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

  it("postingMode · F-151 · PRD:619", () => {
    expect(postingModeSchema.options).toEqual(["inbox", "direct"]);
  });

  it("privacyLevel · F-152 · PRD:620 — mayúsculas literales de TikTok", () => {
    expect(privacyLevelSchema.options).toEqual([
      "PUBLIC_TO_EVERYONE",
      "MUTUAL_FOLLOW_FRIENDS",
      "FOLLOWER_OF_CREATOR",
      "SELF_ONLY",
    ]);
    expect(() => privacyLevelSchema.parse("public_to_everyone")).toThrow();
  });

  it("instagramSlideshowFormat · F-158 · PRD:626", () => {
    expect(instagramSlideshowFormatSchema.options).toEqual(["carousel", "reel"]);
  });

  it("tiktokSoundMode · DATA-020 · PRD:2138", () => {
    expect(tiktokSoundModeSchema.options).toEqual(["audible", "silent"]);
  });

  it("captionAdjustmentReason — hoy sólo uno · DATA-020 · PRD:2133", () => {
    expect(captionAdjustmentReasonSchema.options).toEqual(["repeated_mention"]);
  });

  it("mediaType / status / origin · DATA-010 · PRD:2093", () => {
    expect(mediaTypeSchema.options).toEqual(["image", "video"]);
    expect(mediaStatusSchema.options).toEqual(["processing", "ready", "failed"]);
    expect(mediaOriginSchema.options).toEqual([
      "manual_upload",
      "generated",
      "demo",
      "internal",
      // PU-MEDIA-002, migración 0013.
      "brand_kit",
    ]);
  });

  it("categorías de media por tipo · F-129 · PRD:601", () => {
    expect(imageMediaCategorySchema.options).toEqual([
      "slideshow-image",
      "green-screen-background",
    ]);
    expect(videoMediaCategorySchema.options).toEqual([
      "background-video",
      "hook-video",
      "green-screen-video",
    ]);
  });

  it("MediaSet.kind · DATA-011 · PRD:2096", () => {
    expect(mediaSetKindSchema.options).toEqual(["SLIDESHOW", "VIDEO", "CURATED"]);
  });

  it("content types de subida · §9.8 · PRD:2339", () => {
    expect(imageContentTypeSchema.options).toEqual([
      "image/jpeg",
      "image/png",
      "image/webp",
    ]);
    expect(videoContentTypeSchema.options).toEqual(["video/mp4", "video/quicktime"]);
    expect(() => imageContentTypeSchema.parse("image/gif")).toThrow();
  });

  it("estados de la reserva de subida · DATA-028 · PRD:2170", () => {
    expect(uploadReservationStateSchema.options).toEqual([
      "reserved",
      "finalizing",
      "committed",
      "failed",
      "expired",
    ]);
  });

  it("catálogos de audio · FR-053 · PRD:1232", () => {
    expect(audioLibrarySchema.options).toEqual(["wall-of-text", "video-hook"]);
  });

  it("Influencer.status · FR-080 · PRD:1511", () => {
    expect(influencerStatusSchema.options).toEqual([
      "generating_variations",
      "training",
      "ready",
      "failed",
      "inactive",
    ]);
  });

  it("genderFilter · FR-055 · PRD:1275", () => {
    expect(genderFilterSchema.options).toEqual(["man", "woman"]);
  });

  it("presets de estilo de caption — los siete · FR-055 · PRD:1279", () => {
    expect(textStylePresetSchema.options).toEqual([
      "tiktok-classic",
      "bold-impact",
      "snapchat",
      "white-box",
      "yellow-pop",
      "clean-karaoke",
      "script-playful",
    ]);
    expect(textStylePresetSchema.options).toHaveLength(7);
  });
});

describe("tipografía · FR-051 · PRD:1186", () => {
  it("las doce familias, en el orden del PRD", () => {
    expect(fontFamilySchema.options).toEqual([
      "tiktok",
      "snapchat",
      "montserrat",
      "poppins",
      "inter",
      "oswald",
      "playfair",
      "caveat",
      "anton",
      "bebas",
      "bangers",
      "pacifico",
    ]);
    expect(fontFamilySchema.options).toHaveLength(12);
  });

  it("las seis primeras aceptan 300–700 en pasos de 100", () => {
    for (const family of [
      "tiktok",
      "snapchat",
      "montserrat",
      "poppins",
      "inter",
      "oswald",
    ] as const) {
      expect(FONT_WEIGHTS[family]).toEqual([300, 400, 500, 600, 700]);
    }
  });

  it("playfair y caveat aceptan 400–700", () => {
    expect(FONT_WEIGHTS.playfair).toEqual([400, 500, 600, 700]);
    expect(FONT_WEIGHTS.caveat).toEqual([400, 500, 600, 700]);
  });

  it("anton, bebas, bangers y pacifico sólo 400", () => {
    for (const family of ["anton", "bebas", "bangers", "pacifico"] as const) {
      expect(FONT_WEIGHTS[family]).toEqual([400]);
    }
  });

  it("background.style · PRD:1185", () => {
    expect(textBackgroundStyleSchema.options).toEqual(["pill", "full-width"]);
  });

  it("textAlign del payload de build · FR-070 · PRD:1453", () => {
    expect(textAlignSchema.options).toEqual(["left", "center", "right"]);
  });

  it("los colores son #RRGGBB · PRD:1185", () => {
    expect(hexColorSchema.parse("#FFFFFF")).toBe("#FFFFFF");
    expect(hexColorSchema.parse("#000000")).toBe("#000000");
    expect(() => hexColorSchema.parse("#FFF")).toThrow();
    expect(() => hexColorSchema.parse("white")).toThrow();
    expect(() => hexColorSchema.parse("rgb(255,255,255)")).toThrow();
  });
});
