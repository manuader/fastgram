import { describe, expect, it } from "vitest";

import {
  diffPreferenceFeatures,
  extractPreferenceFeatures,
  parsePreferenceFeature,
  prefMemeKindsOf,
  prefToneOfTags,
  preferenceFeatureKey,
  type PreferenceSubject,
} from "./features.js";

const ANGLE = "0b9a8c9e-6f0e-4d7c-9a51-3f1e2d4c5b6a";
const INFLUENCER = "1b9a8c9e-6f0e-4d7c-9a51-3f1e2d4c5b6a";
const TRACK = "2b9a8c9e-6f0e-4d7c-9a51-3f1e2d4c5b6a";

const greenScreen: PreferenceSubject = {
  format: "green-screen",
  angleId: ANGLE,
  influencerId: null,
  origin: "prompt",
  background: { mediaType: "image", source: "brand", tags: ["dark", "office"] },
  clip: {
    mediaType: "video",
    source: "imported",
    tags: ["shocked face", "reaction", "omg"],
  },
  music: null,
  texts: ["When the client says 'quick change'"],
  textStyle: { presetId: "bold-impact", fontFamily: "inter", fontSize: 18, boxed: false },
  durationSec: 5,
};

describe("extractPreferenceFeatures", () => {
  it("saca los rasgos de un green screen, ordenados y sin repetir", () => {
    expect(extractPreferenceFeatures(greenScreen)).toEqual(
      [
        `angle=${ANGLE}`,
        "bg.source=brand",
        "bg.tone=dark",
        "bg.type=image",
        "clip.kind=reaction",
        "clip.kind=shock",
        "clip.source=imported",
        "clip.type=video",
        "duration=short",
        "format=green-screen",
        "influencer=none",
        "music=none",
        "origin=prompt",
        "text.box=no",
        "text.font=inter",
        "text.len=short",
        "text.preset=bold-impact",
        "text.size=medium",
      ].sort(),
    );
  });

  it("es determinista: la misma entrada, la misma lista", () => {
    expect(extractPreferenceFeatures(greenScreen)).toEqual(
      extractPreferenceFeatures({ ...greenScreen }),
    );
  });

  it("lo que no se sabe no genera rasgo (y no se inventa un valor)", () => {
    expect(extractPreferenceFeatures({ format: "wall-of-text" })).toEqual([
      "format=wall-of-text",
    ]);
  });

  it("descarta valores fuera del vocabulario: texto libre, formato raro, id que no es uuid", () => {
    const f = extractPreferenceFeatures({
      format: "hologram",
      angleId: "not-a-uuid",
      clip: { mediaType: "video", tags: ["my cousin at the beach", "blurry"] },
      textStyle: { presetId: "comic-sans-deluxe", animation: "wiggle" },
    });
    expect(f).toEqual(["clip.type=video"]);
  });

  it("una pista de música: track + id + origen", () => {
    expect(
      extractPreferenceFeatures({
        format: "wall-of-text",
        music: { trackId: TRACK, source: "import" },
      }),
    ).toEqual(
      [
        "format=wall-of-text",
        "music.source=import",
        `music.track=${TRACK}`,
        "music=track",
      ].sort(),
    );
  });

  it("buckets de texto, duración y tamaño", () => {
    const long = "x".repeat(200);
    const f = extractPreferenceFeatures({
      format: "slideshow",
      texts: [long],
      durationSec: 30,
      textStyle: { fontSize: 40 },
      influencerId: INFLUENCER,
    });
    expect(f).toContain("text.len=long");
    expect(f).toContain("duration=long");
    expect(f).toContain("text.size=large");
    expect(f).toContain(`influencer=${INFLUENCER}`);
  });
});

describe("vocabulario", () => {
  it("un tipo de meme sale por palabra entera, no por substring", () => {
    expect(prefMemeKindsOf(["shockwave physics"])).toEqual([]);
    expect(prefMemeKindsOf(["shocked face"])).toEqual(["shock"]);
  });

  it("como mucho tres tipos por clip", () => {
    expect(
      prefMemeKindsOf(["reaction", "lol", "omg", "facepalm", "cringe", "party"]),
    ).toHaveLength(3);
  });

  it("el tono sale de las etiquetas; si se contradicen, no hay tono", () => {
    expect(prefToneOfTags(["night city"])).toBe("dark");
    expect(prefToneOfTags(["bright kitchen"])).toBe("light");
    expect(prefToneOfTags(["dark", "bright"])).toBeNull();
    expect(prefToneOfTags([])).toBeNull();
  });

  it("parsePreferenceFeature rechaza lo que no salió de preferenceFeatureKey", () => {
    expect(parsePreferenceFeature("bg.tone=dark")).toMatchObject({
      family: "bg.tone",
      value: "dark",
      aspect: "background",
      ownerLevel: true,
    });
    expect(parsePreferenceFeature("angle=" + ANGLE)?.ownerLevel).toBe(false);
    expect(parsePreferenceFeature("bg.tone=purple")).toBeNull();
    expect(parsePreferenceFeature("whatever=1")).toBeNull();
    expect(preferenceFeatureKey("format", "  Green-Screen ")).toBe("format=green-screen");
  });
});

describe("diffPreferenceFeatures", () => {
  it("cambiar el fondo oscuro por uno claro es un cambio de fondo, y sólo eso", () => {
    const before = extractPreferenceFeatures(greenScreen);
    const after = extractPreferenceFeatures({
      ...greenScreen,
      background: { mediaType: "image", source: "library", tags: ["bright"] },
    });
    expect(diffPreferenceFeatures(before, after)).toEqual([
      {
        aspect: "background",
        removed: ["bg.source=brand", "bg.tone=dark"],
        added: ["bg.source=library", "bg.tone=light"],
      },
    ]);
  });

  it("un cambio que no mueve ningún rasgo no es una señal", () => {
    const before = extractPreferenceFeatures(greenScreen);
    const after = extractPreferenceFeatures({
      ...greenScreen,
      texts: ["Another short hook"],
    });
    expect(diffPreferenceFeatures(before, after)).toEqual([]);
  });

  it("forced: regenerar la copy cuenta aunque el texto nuevo todavía no esté", () => {
    const before = extractPreferenceFeatures(greenScreen);
    expect(diffPreferenceFeatures(before, before, ["text"])).toEqual([
      { aspect: "text", removed: ["text.len=short"], added: [] },
    ]);
  });

  it("quitar la música y cambiar el estilo son dos aspectos", () => {
    const before = extractPreferenceFeatures({
      ...greenScreen,
      music: { trackId: TRACK, source: "upload" },
    });
    const after = extractPreferenceFeatures({
      ...greenScreen,
      music: null,
      textStyle: { ...greenScreen.textStyle, boxed: true },
    });
    const diff = diffPreferenceFeatures(before, after);
    expect(diff.map((d) => d.aspect)).toEqual(["music", "style"]);
    expect(diff[0]?.added).toEqual(["music=none"]);
    expect(diff[1]).toEqual({
      aspect: "style",
      removed: ["text.box=no"],
      added: ["text.box=yes"],
    });
  });
});
