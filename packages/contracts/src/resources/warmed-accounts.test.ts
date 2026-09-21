import { describe, expect, it } from "vitest";
import {
  WARMED_ACCOUNTS_MAX_VISIBLE,
  WARMED_ACCOUNT_WARMING_DAYS,
  listWarmedAccountsResponseSchema,
  postingAvailabilitySchema,
  warmedAccountCountrySchema,
  warmedAccountSchema,
} from "./warmed-accounts";
import { audioTrackSchema, listAudioQuerySchema } from "./audio";
import {
  listTiktokSoundsQuerySchema,
  SIGNED_PREVIEW_URL_TTL_HOURS,
} from "./tiktok-sounds";
import { connectionSchema } from "./connections";

const account = {
  warmedAccountId: "wa_1",
  accountType: "warmed" as const,
  platform: "tiktok" as const,
  username: "ellaparkergrowth",
  displayName: "Ella Parker",
  status: "active",
  postable: true,
  postingAvailability: "available" as const,
  minLeadTimeMs: 172_800_000,
  createdAt: 1,
  updatedAt: 2,
};

describe("warmed accounts · FR-130 · PRD:1695-1705", () => {
  it("máximo 100 cuentas visibles, sin cursor · PRD:1695", () => {
    expect(WARMED_ACCOUNTS_MAX_VISIBLE).toBe(100);
    const hundred = Array.from({ length: 100 }, () => account);
    expect(
      listWarmedAccountsResponseSchema.parse({
        data: hundred,
        replacementDecisions: [],
        slotBalance: 3,
        minLeadTimeMs: 172_800_000,
      }).data,
    ).toHaveLength(100);
    expect(() =>
      listWarmedAccountsResponseSchema.parse({
        data: [...hundred, account],
        replacementDecisions: [],
        slotBalance: 0,
        minLeadTimeMs: 0,
      }),
    ).toThrow();
  });

  it("la respuesta no lleva `pagination`: este listado no pagina", () => {
    expect(() =>
      listWarmedAccountsResponseSchema.parse({
        data: [],
        replacementDecisions: [],
        slotBalance: 0,
        minLeadTimeMs: 0,
        pagination: { cursor: null, hasMore: false },
      }),
    ).toThrow();
  });

  it("5 días de calentamiento humano · PRD:1687", () => {
    expect(WARMED_ACCOUNT_WARMING_DAYS).toBe(5);
  });

  it("postingAvailability · PRD:1697", () => {
    expect(postingAvailabilitySchema.options).toEqual([
      "available",
      "checking",
      "replacement_needed",
    ]);
  });

  it("país US o EU · DATA-017 · PRD:2114", () => {
    expect(warmedAccountCountrySchema.options).toEqual(["US", "EU"]);
  });

  it("sólo tiktok e instagram · PRD:1705", () => {
    expect(() =>
      warmedAccountSchema.parse({ ...account, platform: "youtube" }),
    ).toThrow();
  });
});

describe("audio · FR-053 · PRD:1232", () => {
  it("`for` es obligatorio y sólo acepta los dos catálogos", () => {
    expect(listAudioQuerySchema.parse({ for: "wall-of-text" }).for).toBe("wall-of-text");
    expect(() => listAudioQuerySchema.parse({})).toThrow();
    expect(() => listAudioQuerySchema.parse({ for: "slideshow" })).toThrow();
  });

  it("una pista pertenece a una de las dos librerías · DATA-012 · PRD:2099", () => {
    expect(
      audioTrackSchema.parse({
        audioId: "aud_1",
        url: "https://cdn.example.com/western.mp3",
        description: "western",
        sizeMb: 1.1,
        library: "video-hook",
      }).library,
    ).toBe("video-hook");
  });
});

describe("tiktok sounds · F-159 · PRD:627", () => {
  it("el query exige warmedAccountId", () => {
    expect(
      listTiktokSoundsQuerySchema.parse({ warmedAccountId: "wa_1" }).warmedAccountId,
    ).toBe("wa_1");
    expect(() => listTiktokSoundsQuerySchema.parse({})).toThrow();
  });

  it("las URLs firmadas viven 1 hora · NFR-008 · PRD:2958", () => {
    expect(SIGNED_PREVIEW_URL_TTL_HOURS).toBe(1);
  });
});

describe("connections · DATA-016 · PRD:2111 · NFR-007 · PRD:2957", () => {
  it("nunca expone accessToken ni refreshToken", () => {
    const base = {
      _id: "con_1",
      platform: "tiktok" as const,
      platformUserId: "u1",
      platformUsername: "ella",
      scopes: ["video.publish"],
      publishable: true,
      tokenExpiry: 1_700_000_000_000,
      status: "active" as const,
      createdAt: 1,
      updatedAt: 2,
    };
    expect(connectionSchema.parse(base).publishable).toBe(true);
    expect(() => connectionSchema.parse({ ...base, accessToken: "secret" })).toThrow();
    expect(() => connectionSchema.parse({ ...base, refreshToken: "secret" })).toThrow();
  });
});
