import { describe, expect, it } from "vitest";
import {
  CONTENT_MIX_WEIGHT_SUM,
  DISCOVERY_QUEUE_TARGET_ITEMS,
  INFLUENCER_CHANCE_DEFAULT,
  SMART_TEXT_POSITIONING_DEFAULT,
  angleWeightsSchema,
  blitzQueueSchema,
  blitzSuggestionSchema,
  contentMixWeightsSchema,
  runBlitzRequestSchema,
  settingsApplicationSchema,
  textStyleWeightsSchema,
  updateBlitzPreferencesRequestSchema,
} from "./blitz.js";

const mix = {
  slideshowWeight: 45,
  wallOfTextWeight: 45,
  greenScreenWeight: 10,
  videoHookWeight: 0,
};

describe("POST /blitz · FR-050 Validation · PRD:1129", () => {
  it("acepta un contentType de los cuatro y un aspectRatio de los cuatro", () => {
    expect(runBlitzRequestSchema.parse({ contentType: "green-screen" }).contentType).toBe(
      "green-screen",
    );
    expect(runBlitzRequestSchema.parse({ aspectRatio: "9:16" }).aspectRatio).toBe("9:16");
  });

  it("body vacío es válido: sin contentType la cola decide", () => {
    expect(runBlitzRequestSchema.parse({})).toEqual({});
  });

  it("un valor no reconocido se rechaza → 400 bad_request", () => {
    expect(() => runBlitzRequestSchema.parse({ contentType: "reel" })).toThrow();
    expect(() => runBlitzRequestSchema.parse({ aspectRatio: "16:9" })).toThrow();
  });
});

describe("POST /blitz con suggestionId · PU-BLITZ-002", () => {
  it("suggestionId es opcional y convive con los otros campos", () => {
    expect(runBlitzRequestSchema.parse({ suggestionId: "abc" })).toEqual({
      suggestionId: "abc",
    });
    expect(() => runBlitzRequestSchema.parse({ suggestionId: "" })).toThrow();
  });

  it("sigue siendo estricto: una clave desconocida → 400", () => {
    expect(() => runBlitzRequestSchema.parse({ suggestion: "abc" })).toThrow();
  });
});

describe("GET /blitz/queue · la forma del deck, estricta", () => {
  const completa = {
    id: "0f7c1c1e-0000-4000-8000-000000000001",
    contentType: "slideshow",
    generatedText: "uno\n\ndos",
    aiExplanation: "- porque sí",
    influencer: { id: "i1", name: "Ana" },
    angle: { id: "a1", title: "Ahorro" },
    remixSource: {
      url: "https://www.tiktok.com/@x/video/1",
      thumbnailUrl: "https://cdn.test/t.jpg",
      likes: 10,
      views: 100,
    },
    preview: {
      slides: [{ imageUrl: "https://bucket.test/a.png", text: "uno" }, { text: "dos" }],
    },
  };

  it("acepta la sugerencia completa y la mínima", () => {
    expect(blitzSuggestionSchema.parse(completa)).toEqual(completa);
    expect(
      blitzQueueSchema.parse([{ id: "x", contentType: "wall-of-text" }]),
    ).toHaveLength(1);
  });

  it("el servidor omite, no manda null", () => {
    expect(() =>
      blitzSuggestionSchema.parse({ ...completa, generatedText: null }),
    ).toThrow();
    expect(() => blitzSuggestionSchema.parse({ ...completa, preview: null })).toThrow();
  });

  it("no manda claves que el deck no conoce", () => {
    expect(() => blitzSuggestionSchema.parse({ ...completa, buildPlan: {} })).toThrow();
    expect(() =>
      blitzSuggestionSchema.parse({ ...completa, preview: { backgroundUrl: "no-url" } }),
    ).toThrow();
  });
});

describe("content mix · FR-055 · PRD:1269 y PRD:1277", () => {
  it("los cuatro pesos suman exactamente 100", () => {
    expect(CONTENT_MIX_WEIGHT_SUM).toBe(100);
    expect(contentMixWeightsSchema.parse(mix)).toEqual(mix);
  });

  it("una suma distinta de 100 se rechaza", () => {
    expect(() => contentMixWeightsSchema.parse({ ...mix, videoHookWeight: 1 })).toThrow();
    expect(() =>
      contentMixWeightsSchema.parse({ ...mix, greenScreenWeight: 5 }),
    ).toThrow();
  });

  it("un set PARCIAL de los cuatro pesos se rechaza — se validan como unidad", () => {
    expect(() =>
      updateBlitzPreferencesRequestSchema.parse({ slideshowWeight: 100 }),
    ).toThrow();
    expect(() =>
      updateBlitzPreferencesRequestSchema.parse({
        slideshowWeight: 50,
        wallOfTextWeight: 50,
      }),
    ).toThrow();
  });

  it("los cuatro juntos y sumando 100 pasan", () => {
    expect(updateBlitzPreferencesRequestSchema.parse(mix)).toEqual(mix);
  });

  it("ninguno de los cuatro también es válido", () => {
    expect(updateBlitzPreferencesRequestSchema.parse({ remixPercentage: 80 })).toEqual({
      remixPercentage: 80,
    });
  });
});

describe("PATCH /blitz/preferences · FR-055 Validation · PRD:1292", () => {
  it("body vacío `{}` → 400", () => {
    expect(() => updateBlitzPreferencesRequestSchema.parse({})).toThrow();
  });

  it("enviar settingsApplication en el PATCH → 400 (es sólo de respuesta) · PRD:1288", () => {
    expect(() =>
      updateBlitzPreferencesRequestSchema.parse({
        settingsApplication: { mode: "future_generations", targetQueuedItems: 5 },
      }),
    ).toThrow();
  });

  it("genderFilter acepta man, woman y null · PRD:1274", () => {
    expect(
      updateBlitzPreferencesRequestSchema.parse({ genderFilter: null }).genderFilter,
    ).toBeNull();
    expect(
      updateBlitzPreferencesRequestSchema.parse({ genderFilter: "man" }).genderFilter,
    ).toBe("man");
    expect(() =>
      updateBlitzPreferencesRequestSchema.parse({ genderFilter: "male" }),
    ).toThrow();
  });

  it("los porcentajes van de 0 a 100 · PRD:1270-1273", () => {
    expect(
      updateBlitzPreferencesRequestSchema.parse({ influencerChance: 0 }).influencerChance,
    ).toBe(0);
    expect(
      updateBlitzPreferencesRequestSchema.parse({ influencerChance: 100 })
        .influencerChance,
    ).toBe(100);
    expect(() =>
      updateBlitzPreferencesRequestSchema.parse({ influencerChance: 101 }),
    ).toThrow();
    expect(() =>
      updateBlitzPreferencesRequestSchema.parse({ remixPercentage: -1 }),
    ).toThrow();
  });

  it("influencerChance acepta decimales · PRD:1273", () => {
    expect(
      updateBlitzPreferencesRequestSchema.parse({ influencerChance: 12.5 })
        .influencerChance,
    ).toBe(12.5);
  });
});

describe("angleWeights · FR-055 · PRD:1276 y PRD:1274", () => {
  it("suman 100 — p. ej. el reparto par de 3 ángulos: 34/33/33", () => {
    expect(angleWeightsSchema.parse({ a: 34, b: 33, c: 33 })).toEqual({
      a: 34,
      b: 33,
      c: 33,
    });
  });

  it("una suma distinta de 100 se rechaza", () => {
    expect(() => angleWeightsSchema.parse({ a: 50, b: 40 })).toThrow();
  });

  it("el mapa vacío es válido: 0 ángulos activos limpia el mapa", () => {
    expect(angleWeightsSchema.parse({})).toEqual({});
  });
});

describe("textStyleWeights · FR-055 · PRD:1277 y PRD:1277", () => {
  it("`{}` desactiva el mix de estilos", () => {
    expect(textStyleWeightsSchema.parse({})).toEqual({});
  });

  it("pesos enteros que suman 100", () => {
    expect(textStyleWeightsSchema.parse({ "tiktok-classic": 60, snapchat: 40 })).toEqual({
      "tiktok-classic": 60,
      snapchat: 40,
    });
  });

  it("un preset desconocido → 400", () => {
    expect(() => textStyleWeightsSchema.parse({ "neon-glow": 100 })).toThrow();
  });

  it("pesos no enteros se rechazan", () => {
    expect(() =>
      textStyleWeightsSchema.parse({ "tiktok-classic": 99.5, snapchat: 0.5 }),
    ).toThrow();
  });

  it("una suma distinta de 100 se rechaza", () => {
    expect(() => textStyleWeightsSchema.parse({ "tiktok-classic": 90 })).toThrow();
  });
});

describe("valores por defecto y constantes de respuesta", () => {
  it("influencerChance default 50 · PRD:1273", () => {
    expect(INFLUENCER_CHANCE_DEFAULT).toBe(50);
  });

  it("smartTextPositioning default true · PRD:1274 · AI-014 · PRD:2688", () => {
    expect(SMART_TEXT_POSITIONING_DEFAULT).toBe(true);
  });

  it("settingsApplication es literal: mode 'future_generations' y targetQueuedItems 5 · PRD:1288", () => {
    expect(DISCOVERY_QUEUE_TARGET_ITEMS).toBe(5);
    expect(
      settingsApplicationSchema.parse({
        mode: "future_generations",
        targetQueuedItems: 5,
      }),
    ).toEqual({ mode: "future_generations", targetQueuedItems: 5 });
    expect(() =>
      settingsApplicationSchema.parse({
        mode: "future_generations",
        targetQueuedItems: 10,
      }),
    ).toThrow();
  });
});
