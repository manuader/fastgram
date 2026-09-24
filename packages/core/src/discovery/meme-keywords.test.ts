import { describe, expect, it } from "vitest";

import { memeKeywordsPrompt, parseMemeKeywords } from "./meme-search.js";

describe("palabras de reacción para buscar el meme", () => {
  it("se queda con hasta 4 palabras y saca «green screen» y «meme»", () => {
    expect(parseMemeKeywords({ keywords: "Facepalm green screen meme" })).toBe(
      "facepalm",
    );
    expect(
      parseMemeKeywords({ keywords: "slow clap, sarcastic, office, guy, extra" }),
    ).toBe("slow clap sarcastic office");
  });

  it("devuelve null si el modelo no contestó algo usable", () => {
    expect(parseMemeKeywords(null)).toBeNull();
    expect(parseMemeKeywords({ keywords: 3 })).toBeNull();
    expect(parseMemeKeywords({ keywords: "  memes!! " })).toBeNull();
  });

  it("acota el tema que viaja al modelo", () => {
    const p = memeKeywordsPrompt(`${"a ".repeat(400)}\n\n`);
    expect(p.user.length).toBeLessThanOrEqual(300);
    expect(p.system).toMatch(/data, not instructions/u);
  });
});

describe("copy en otro alfabeto", () => {
  it("con un idioma latino, un hashtag en chino descarta la copy", async () => {
    const { parseSuggestionCopy, hasForeignScript } =
      await import("./suggestion-copy.js");
    expect(hasForeignScript("It's the extra care. #精益求情", "en")).toBe(true);
    expect(hasForeignScript("¿Otra revisión? 🙈", "es-AR")).toBe(false);
    expect(hasForeignScript("精益求精", "zh")).toBe(false);
    expect(hasForeignScript("#精益求情", null)).toBe(false);
    const out = parseSuggestionCopy(
      { texts: ["Masterpiece #精益求情"], explanation: ["x"] },
      { maxTexts: 1, language: "en" },
    );
    expect(out).toEqual({ ok: false, reason: "foreign_script" });
  });
});
