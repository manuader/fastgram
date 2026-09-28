import { describe, expect, it } from "vitest";

import {
  LIBRARY_METADATA_SCHEMA_VERSION,
  libraryAssetMetadataSchema,
  libraryLicenseSchema,
  libraryUploadRequestSchema,
  listLibraryAssetsQuerySchema,
  updateLibraryAssetRequestSchema,
  type LibraryAssetMetadata,
} from "./library.js";

const VERIFIED = "2026-09-28T12:00:00.000Z";

const ccBy = {
  type: "cc-by",
  version: "3.0",
  attribution: '"Court Scale Green Screen" by Jane Doe, CC BY 3.0, via Wikimedia Commons',
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Court_Scale_Green_Screen.webm",
  author: "Jane Doe",
  licenseUrl: "https://creativecommons.org/licenses/by/3.0",
  verifiedAt: VERIFIED,
} as const;

const base: LibraryAssetMetadata = {
  schemaVersion: 1,
  kind: "green_screen_video",
  description: "A judge's scale tips to one side on a green background.",
  memeType: "overlay_effect",
  emotions: ["neutral"],
  useCases: ["when weighing two options"],
  characters: [],
  tags: ["scale", "justice"],
  language: null,
  hasSpeech: false,
  durationSec: 30,
  aspect: { ratio: "16:9", width: 1920, height: 1080 },
  framing: "object",
  chroma: { type: "green", keyQuality: 0.97, keyColor: "#00B140" },
  nsfw: false,
  energy: "low",
  needsReview: false,
  license: ccBy,
};

const issues = (r: { success: boolean; error?: { issues: { path: unknown[] }[] } }) =>
  r.success ? [] : (r.error?.issues ?? []).map((i) => i.path.join("."));

describe("metadatos de la biblioteca global (D-19)", () => {
  it("un JSON completo y con licencia verificable pasa", () => {
    expect(libraryAssetMetadataSchema.safeParse(base).success).toBe(true);
  });

  it("la versión del esquema es 1 y otra no entra", () => {
    expect(LIBRARY_METADATA_SCHEMA_VERSION).toBe(1);
    const r = libraryAssetMetadataSchema.safeParse({ ...base, schemaVersion: 2 });
    expect(issues(r)).toContain("schemaVersion");
  });

  it("sin licencia no entra: no hay `unknown`", () => {
    const { license: _omit, ...rest } = base;
    expect(issues(libraryAssetMetadataSchema.safeParse(rest))).toContain("license");
    const unknown = { ...base, license: { ...ccBy, type: "unknown" } };
    expect(issues(libraryAssetMetadataSchema.safeParse(unknown))).toContain(
      "license.type",
    );
  });

  it("CC BY sin atribución se rechaza", () => {
    const { attribution: _omit, ...noAttribution } = ccBy;
    const r = libraryLicenseSchema.safeParse(noAttribution);
    expect(issues(r)).toEqual(["attribution"]);
  });

  it("CC BY-SA no entra (share-alike sobre una pieza compuesta)", () => {
    const r = libraryLicenseSchema.safeParse({ ...ccBy, type: "cc-by-sa" });
    expect(issues(r)).toContain("type");
  });

  it("una licencia de terceros sin sourceUrl o licenseUrl no se puede verificar", () => {
    const { sourceUrl: _s, licenseUrl: _l, ...bare } = ccBy;
    const r = libraryLicenseSchema.safeParse({ ...bare, type: "cc0" });
    expect(issues(r).sort()).toEqual(["licenseUrl", "sourceUrl"]);
  });

  it("propio o generado sólo pide la fecha de la declaración", () => {
    expect(
      libraryLicenseSchema.safeParse({ type: "own", verifiedAt: VERIFIED }).success,
    ).toBe(true);
  });

  it("nsfw tiene que ser false", () => {
    const r = libraryAssetMetadataSchema.safeParse({ ...base, nsfw: true });
    expect(issues(r)).toContain("nsfw");
  });

  it("un green-screen sin croma, o un video sin duración medida, no valida", () => {
    const noKey = {
      ...base,
      chroma: { type: "none", keyQuality: null, keyColor: null },
    };
    expect(issues(libraryAssetMetadataSchema.safeParse(noKey))).toContain("chroma.type");
    const noDuration = { ...base, durationSec: null };
    expect(issues(libraryAssetMetadataSchema.safeParse(noDuration))).toContain(
      "durationSec",
    );
  });

  it("keyQuality es una proporción 0–1", () => {
    const r = libraryAssetMetadataSchema.safeParse({
      ...base,
      chroma: { ...base.chroma, keyQuality: 1.2 },
    });
    expect(issues(r)).toContain("chroma.keyQuality");
  });

  it("idioma sólo con habla", () => {
    const r = libraryAssetMetadataSchema.safeParse({ ...base, language: "en" });
    expect(issues(r)).toContain("language");
    expect(
      libraryAssetMetadataSchema.safeParse({ ...base, language: "en", hasSpeech: true })
        .success,
    ).toBe(true);
  });

  it("campos de más no entran (strict)", () => {
    const r = libraryAssetMetadataSchema.safeParse({ ...base, rating: 5 });
    expect(r.success).toBe(false);
  });
});

describe("pedidos de la API", () => {
  it("la subida exige declarar la licencia y que la extensión coincida", () => {
    const ok = libraryUploadRequestSchema.safeParse({
      filename: "clip.webm",
      contentType: "video/webm",
      sizeBytes: 1000,
      license: { type: "own" },
    });
    expect(ok.success).toBe(true);
    const noLicense = libraryUploadRequestSchema.safeParse({
      filename: "clip.webm",
      contentType: "video/webm",
      sizeBytes: 1000,
    });
    expect(issues(noLicense)).toContain("license");
    const mismatch = libraryUploadRequestSchema.safeParse({
      filename: "clip.mp4",
      contentType: "video/webm",
      sizeBytes: 1000,
      license: { type: "own" },
    });
    expect(issues(mismatch)).toContain("filename");
  });

  it("los filtros de lista aceptan listas separadas por coma", () => {
    const q = listLibraryAssetsQuerySchema.parse({
      kind: "green_screen_video,background_video",
      emotion: "shock",
      maxDuration: "8",
    });
    expect(q.kind).toEqual(["green_screen_video", "background_video"]);
    expect(q.emotion).toEqual(["shock"]);
    expect(q.maxDuration).toBe(8);
    expect(q.limit).toBe(40);
  });

  it("editar no toca lo medido ni la licencia", () => {
    for (const field of ["durationSec", "chroma", "license", "aspect", "nsfw"]) {
      const r = updateLibraryAssetRequestSchema.safeParse({ [field]: null });
      expect(r.success, field).toBe(false);
    }
  });
});
