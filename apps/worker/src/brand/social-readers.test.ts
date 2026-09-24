import { LadderSocialReader } from "@fastgram/adapters/social-readers";
import { describe, expect, it } from "vitest";

import { socialReadersFromEnv } from "./social-readers.js";

describe("socialReadersFromEnv — PU-SCRAPE-001/002", () => {
  it("sin variables no monta nada, y dice por qué", () => {
    const m = socialReadersFromEnv({});
    expect(m.readers).toEqual({});
    expect(m.skipped.map((s) => s.source)).toEqual(["instagram", "tiktok", "x"]);
  });

  it("cada URL monta su extractor", () => {
    const m = socialReadersFromEnv({
      INSTAGRAM_EXTRACTOR_URL: "http://127.0.0.1:8000",
      TIKTOK_EXTRACTOR_URL: "http://127.0.0.1:8001",
      TIKTOK_EXTRACTOR_API_KEY: "k",
      X_EXTRACTOR_URL: "https://api.fxtwitter.com",
    });
    expect(Object.keys(m.readers).sort()).toEqual(["instagram", "tiktok", "x"]);
    expect(m.readers.instagram?.capabilities().tiers).toEqual(["C_page_fetch"]);
    expect(m.skipped).toEqual([]);
    // Los valores no aparecen en lo que se loguea.
    expect(JSON.stringify(m.mounted)).not.toContain("127.0.0.1");
  });

  it("con Business Discovery e instaloader: escalera B → C", () => {
    const m = socialReadersFromEnv({
      INSTAGRAM_EXTRACTOR_URL: "http://127.0.0.1:8000",
      INSTAGRAM_BD_IG_USER_ID: "1784",
      INSTAGRAM_BD_ACCESS_TOKEN: "secreto",
    });
    expect(m.readers.instagram).toBeInstanceOf(LadderSocialReader);
    expect(m.readers.instagram?.capabilities().tiers).toEqual([
      "B_public_api",
      "C_page_fetch",
    ]);
    expect(JSON.stringify(m)).not.toContain("secreto");
  });

  it("Business Discovery a medias es un error de arranque", () => {
    expect(() => socialReadersFromEnv({ INSTAGRAM_BD_IG_USER_ID: "1" })).toThrow(
      /van juntas/,
    );
  });

  it("una URL inválida es un error de arranque que nombra la variable", () => {
    expect(() => socialReadersFromEnv({ TIKTOK_EXTRACTOR_URL: "no es url" })).toThrow(
      /TIKTOK_EXTRACTOR_URL/,
    );
    expect(() => socialReadersFromEnv({ X_EXTRACTOR_URL: "ftp://x" })).toThrow(/http/);
  });
});
