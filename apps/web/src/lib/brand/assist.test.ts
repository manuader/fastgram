import { brandSourceSchema, type BrandSource } from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import {
  ASSIST_MAX_CAPTIONS,
  ASSIST_TEXT_MAX,
  assistRequestFrom,
  canAssist,
  splitCaptions,
} from "./assist";

const source = (over: Record<string, unknown> = {}): BrandSource =>
  brandSourceSchema.parse({
    _id: "11111111-1111-4111-8111-111111111111",
    sourceType: "instagram",
    handle: "mimarca",
    canonicalUrl: "https://instagram.com/mimarca",
    displayName: null,
    avatarUrl: null,
    isPrimary: true,
    acquisitionTier: "D_assisted",
    status: "failed",
    failureReason: "unsupported_platform",
    lastAnalysedAt: null,
    analysisCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...over,
  });

describe("canAssist — P1-BRAND-014", () => {
  it("una fuente social fallida sí; una web o una que anda, no", () => {
    expect(canAssist(source())).toBe(true);
    expect(canAssist(source({ sourceType: "tiktok", failureReason: "private" }))).toBe(
      true,
    );
    expect(canAssist(source({ status: "ready" }))).toBe(false);
    expect(canAssist(source({ status: "analyzing" }))).toBe(false);
    expect(
      canAssist(
        source({ sourceType: "website", handle: "x.com", canonicalUrl: "https://x.com" }),
      ),
    ).toBe(false);
  });
});

describe("splitCaptions", () => {
  it("separa por línea en blanco; un salto simple queda dentro del caption", () => {
    expect(splitCaptions("uno\nsigue uno\n\n  dos  \n\n\n\ntres\n")).toEqual([
      "uno\nsigue uno",
      "dos",
      "tres",
    ]);
    expect(splitCaptions("   \n\n  ")).toEqual([]);
  });
});

describe("assistRequestFrom", () => {
  it("arma el cuerpo sin claves vacías", () => {
    expect(assistRequestFrom("  mi bio ", "")).toEqual({
      ok: true,
      body: { bio: "mi bio" },
    });
    expect(assistRequestFrom("", "a\n\nb")).toEqual({
      ok: true,
      body: { captions: ["a", "b"] },
    });
  });

  it.each([
    ["", "  ", "empty"],
    ["x".repeat(ASSIST_TEXT_MAX + 1), "", "bioTooLong"],
    ["", `ok\n\n${"c".repeat(ASSIST_TEXT_MAX + 1)}`, "captionTooLong"],
    [
      "",
      Array.from({ length: ASSIST_MAX_CAPTIONS + 1 }, (_, i) => `c${String(i)}`).join(
        "\n\n",
      ),
      "tooManyCaptions",
    ],
  ])("rechaza antes de mandar (%#: %s)", (bio, captions, kind) => {
    const r = assistRequestFrom(bio, captions);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem.kind).toBe(kind);
  });

  it("el caption largo se nombra por su número", () => {
    const r = assistRequestFrom("", `ok\n\n${"c".repeat(ASSIST_TEXT_MAX + 1)}`);
    expect(!r.ok && r.problem).toEqual({
      kind: "captionTooLong",
      max: ASSIST_TEXT_MAX,
      index: 2,
    });
  });
});
