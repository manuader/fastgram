import { describe, expect, it } from "vitest";
import type { Rng } from "@fastgram/ports";
import { DomainError } from "../errors.js";
import {
  TARGET_QUEUED_ITEMS,
  TEXT_STYLE_PRESETS,
  assertValidPreferencesPatch,
  assertValidTextStyleWeights,
  settingsApplication,
  type BlitzPreferences,
} from "./blitz-preferences.js";
import {
  eligibleInfluencers,
  planSuggestion,
  type EligibleInfluencer,
} from "./plan-suggestion.js";

// ───────────────────────────────────────────────────────────────────────────
// Un Rng determinista. Es lo que hace testeable todo este módulo.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Devuelve los valores de `next()` que se le den, en orden, y hace
 * `weightedPick` de forma determinista con la misma secuencia.
 */
function scriptedRng(values: readonly number[]): Rng {
  let i = 0;
  const next = () => {
    const v = values[i % values.length] as number;
    i += 1;
    return v;
  };
  return {
    next,
    nextInt: (min, max) => min + Math.floor(next() * (max - min)),
    weightedPick<T>(items: readonly { value: T; weight: number }[]): T {
      const total = items.reduce((s, it) => s + it.weight, 0);
      if (items.length === 0 || total <= 0) {
        throw new Error("weightedPick: sin items o sin peso");
      }
      let target = next() * total;
      for (const item of items) {
        target -= item.weight;
        if (target < 0) return item.value;
      }
      return items[items.length - 1]!.value;
    },
  };
}

const prefs = (over: Partial<BlitzPreferences> = {}): BlitzPreferences => ({
  slideshowWeight: 45,
  wallOfTextWeight: 45,
  greenScreenWeight: 10,
  videoHookWeight: 0,
  remixPercentage: 50,
  ownMediaPercentage: 50,
  mentionBusinessPercentage: 50,
  influencerChance: 50,
  smartTextPositioning: true,
  genderFilter: null,
  angleWeights: { ang_1: 34, ang_2: 33, ang_3: 33 },
  textStyleWeights: {},
  ...over,
});

const trained = (over: Partial<EligibleInfluencer> = {}): EligibleInfluencer => ({
  id: "inf_1",
  isActive: true,
  isTrained: true,
  gender: "female",
  ...over,
});

const context = (influencers: EligibleInfluencer[] = []) => ({
  activeAngleIds: ["ang_1", "ang_2", "ang_3"],
  influencers,
});

// ───────────────────────────────────────────────────────────────────────────
// FR-055 · Validation
// ───────────────────────────────────────────────────────────────────────────

describe("PATCH de Blitz preferences (FR-055, Validation)", () => {
  const active = ["ang_1", "ang_2"];

  it("body vacío → error", () => {
    expect(() => assertValidPreferencesPatch({}, active)).toThrow(DomainError);
  });

  it("los cuatro pesos van JUNTOS o ninguno", () => {
    expect(() => assertValidPreferencesPatch({ slideshowWeight: 60 }, active)).toThrow(
      DomainError,
    );
    expect(() =>
      assertValidPreferencesPatch(
        {
          slideshowWeight: 60,
          wallOfTextWeight: 30,
          greenScreenWeight: 10,
          videoHookWeight: 0,
        },
        active,
      ),
    ).not.toThrow();
  });

  it("los cuatro pesos suman exactamente 100 — 97 no cuela", () => {
    expect(() =>
      assertValidPreferencesPatch(
        {
          slideshowWeight: 60,
          wallOfTextWeight: 27,
          greenScreenWeight: 10,
          videoHookWeight: 0,
        },
        active,
      ),
    ).toThrow(DomainError);
  });

  it("los porcentajes viven en [0, 100]", () => {
    for (const field of [
      "remixPercentage",
      "ownMediaPercentage",
      "mentionBusinessPercentage",
      "influencerChance",
    ]) {
      expect(() => assertValidPreferencesPatch({ [field]: 0 }, active)).not.toThrow();
      expect(() => assertValidPreferencesPatch({ [field]: 100 }, active)).not.toThrow();
      expect(() => assertValidPreferencesPatch({ [field]: 101 }, active)).toThrow(
        DomainError,
      );
      expect(() => assertValidPreferencesPatch({ [field]: -1 }, active)).toThrow(
        DomainError,
      );
    }
  });

  it("influencerChance acepta decimales (FR-055)", () => {
    expect(() =>
      assertValidPreferencesPatch({ influencerChance: 12.5 }, active),
    ).not.toThrow();
  });

  it("genderFilter es man, woman o null", () => {
    for (const value of ["man", "woman", null]) {
      expect(() =>
        assertValidPreferencesPatch({ genderFilter: value }, active),
      ).not.toThrow();
    }
    expect(() => assertValidPreferencesPatch({ genderFilter: "male" }, active)).toThrow(
      DomainError,
    );
  });

  it("angleWeights tiene que cubrir todos los activos y sumar 100", () => {
    expect(() =>
      assertValidPreferencesPatch({ angleWeights: { ang_1: 50, ang_2: 50 } }, active),
    ).not.toThrow();
    expect(() =>
      assertValidPreferencesPatch({ angleWeights: { ang_1: 100 } }, active),
    ).toThrow(DomainError);
  });

  it("settingsApplication es de sólo respuesta: mandarlo es error", () => {
    expect(() =>
      assertValidPreferencesPatch({ settingsApplication: { mode: "x" } }, active),
    ).toThrow(DomainError);
  });

  it("un campo desconocido se rechaza", () => {
    expect(() => assertValidPreferencesPatch({ turbo: true }, active)).toThrow(
      DomainError,
    );
  });
});

describe("textStyleWeights (FR-055)", () => {
  it("{} DESACTIVA el mix; no es un mapa inválido", () => {
    // Tratarlo como error dejaría al usuario sin forma de volver al default.
    expect(() => assertValidTextStyleWeights({})).not.toThrow();
  });

  it("los presets son los siete del PRD", () => {
    expect(TEXT_STYLE_PRESETS).toHaveLength(7);
    expect(() => assertValidTextStyleWeights({ "tiktok-classic": 100 })).not.toThrow();
    expect(() => assertValidTextStyleWeights({ "mi-preset": 100 })).toThrow(DomainError);
  });

  it("los pesos son enteros y suman 100", () => {
    expect(() =>
      assertValidTextStyleWeights({ "tiktok-classic": 50, snapchat: 50 }),
    ).not.toThrow();
    expect(() =>
      assertValidTextStyleWeights({ "tiktok-classic": 50, snapchat: 40 }),
    ).toThrow(DomainError);
    expect(() =>
      assertValidTextStyleWeights({ "tiktok-classic": 50.5, snapchat: 49.5 }),
    ).toThrow(DomainError);
  });
});

describe("guardar preferencias NUNCA vacía la cola (FR-055, criterio 1)", () => {
  it("el modo es future_generations y no limpia nada", () => {
    expect(settingsApplication()).toEqual({
      mode: "future_generations",
      targetQueuedItems: TARGET_QUEUED_ITEMS,
      clearsExistingQueue: false,
    });
    expect(TARGET_QUEUED_ITEMS).toBe(5);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AI-002 · las seis decisiones
// ───────────────────────────────────────────────────────────────────────────

describe("influencerChance: tirada independiente (FR-055 regla 2 y criterio 4)", () => {
  it("con 0 NUNCA sale influencer, ni con la tirada más baja posible", () => {
    // Con `<=` en vez de `<`, `0 <= 0` sería verdadero y este test fallaría.
    const rng = scriptedRng([0, 0, 0, 0, 0, 0]);
    const plan = planSuggestion(
      rng,
      prefs({ influencerChance: 0 }),
      context([trained()]),
    );
    expect(plan.influencer).toEqual({ decision: "none", reason: "roll_missed" });
  });

  it("con 100 sale SIEMPRE, incluso con la tirada más alta posible", () => {
    // next() vive en [0, 1), así que 0.999… * 100 < 100 sigue siendo cierto.
    const rng = scriptedRng([0.999999, 0.1, 0.1, 0.999999, 0.1, 0.1]);
    const plan = planSuggestion(
      rng,
      prefs({
        influencerChance: 100,
        greenScreenWeight: 0,
        slideshowWeight: 100,
        wallOfTextWeight: 0,
      }),
      context([trained()]),
    );
    expect(plan.influencer.decision).toBe("use");
  });

  it("es una tirada por generación, no una cuota sobre el lote", () => {
    // Diez generaciones con la MISMA secuencia dan el MISMO resultado: no hay
    // estado acumulado que "compense" para llegar al 50 %.
    const results = Array.from({ length: 10 }, () =>
      planSuggestion(
        scriptedRng([0.9, 0.1, 0.1, 0.9, 0.1, 0.1]),
        prefs({ influencerChance: 50 }),
        context([trained()]),
      ),
    );
    const decisions = new Set(results.map((r) => r.influencer.decision));
    expect(decisions.size).toBe(1);
  });
});

describe("green-screen NUNCA usa influencer (FR-055 regla 5)", () => {
  it("aunque influencerChance sea 100 y haya influencers entrenados", () => {
    const rng = scriptedRng([0.1, 0.99, 0.1, 0.1, 0.1, 0.1]);
    const plan = planSuggestion(
      rng,
      prefs({
        influencerChance: 100,
        slideshowWeight: 0,
        wallOfTextWeight: 0,
        greenScreenWeight: 100,
        videoHookWeight: 0,
      }),
      context([trained()]),
    );
    expect(plan.contentType).toBe("green-screen");
    expect(plan.influencer).toEqual({ decision: "none", reason: "green_screen" });
  });
});

describe("sin influencer elegible se cae a contenido regular (FR-055 regla 3)", () => {
  const allIn = prefs({
    influencerChance: 100,
    slideshowWeight: 100,
    wallOfTextWeight: 0,
    greenScreenWeight: 0,
    videoHookWeight: 0,
  });
  const rng = () => scriptedRng([0.1, 0.1, 0.1, 0.1, 0.1, 0.1]);

  it("uno sin entrenar no cuenta — se está entrenando, no está roto", () => {
    const plan = planSuggestion(rng(), allIn, context([trained({ isTrained: false })]));
    expect(plan.influencer).toEqual({
      decision: "none",
      reason: "no_eligible_influencer",
    });
  });

  it("uno inactivo tampoco", () => {
    const plan = planSuggestion(rng(), allIn, context([trained({ isActive: false })]));
    expect(plan.influencer.decision).toBe("none");
  });

  it("sin ninguno, tampoco falla", () => {
    expect(planSuggestion(rng(), allIn, context([])).influencer.decision).toBe("none");
  });
});

describe("genderFilter: excluye el opuesto SÓLO para valores conocidos (regla 4)", () => {
  it("man excluye female y deja male", () => {
    expect(
      eligibleInfluencers(
        [trained({ id: "f", gender: "female" }), trained({ id: "m", gender: "male" })],
        "slideshow",
        "man",
      ),
    ).toEqual(["m"]);
  });

  it("woman excluye male", () => {
    expect(
      eligibleInfluencers(
        [trained({ id: "f", gender: "female" }), trained({ id: "m", gender: "male" })],
        "slideshow",
        "woman",
      ),
    ).toEqual(["f"]);
  });

  it("un género desconocido o ausente NUNCA se descarta", () => {
    // Descartar todo lo que no coincide deja fuera a esos personajes de
    // cualquier workspace que use el filtro, sin explicación posible.
    const out = eligibleInfluencers(
      [
        trained({ id: "nb", gender: "non-binary" }),
        trained({ id: "sin", gender: undefined }),
        trained({ id: "m", gender: "male" }),
      ],
      "slideshow",
      "woman",
    );
    // `male` sí se descarta —es un valor conocido y es el opuesto—, pero los
    // otros dos sobreviven al filtro.
    expect(out).toEqual(["nb", "sin"]);
  });

  it("sin filtro entran todos", () => {
    expect(
      eligibleInfluencers(
        [trained({ id: "a" }), trained({ id: "b" })],
        "slideshow",
        null,
      ),
    ).toEqual(["a", "b"]);
  });

  it("green-screen no devuelve candidatos ni con el filtro apagado", () => {
    expect(eligibleInfluencers([trained()], "green-screen", null)).toEqual([]);
  });
});

describe("las seis decisiones y su orden (AI-002)", () => {
  it("con el mismo Rng sembrado, dos corridas dan el MISMO plan", () => {
    const seed = [0.2, 0.4, 0.6, 0.3, 0.8, 0.5];
    const a = planSuggestion(scriptedRng(seed), prefs(), context([trained()]));
    const b = planSuggestion(scriptedRng(seed), prefs(), context([trained()]));
    expect(a).toEqual(b);
  });

  it("el ángulo sale de angleWeights y respeta los pesos", () => {
    // Con ang_1 al 100, ningún otro puede salir.
    const plan = planSuggestion(
      scriptedRng([0.5, 0.5, 0.99, 0.5, 0.5, 0.5]),
      prefs({ angleWeights: { ang_1: 100, ang_2: 0, ang_3: 0 } }),
      context(),
    );
    expect(plan.angleId).toBe("ang_1");
  });

  it("sin ángulos activos el plan no lleva ángulo", () => {
    const plan = planSuggestion(scriptedRng([0.5]), prefs({ angleWeights: {} }), {
      activeAngleIds: [],
      influencers: [],
    });
    expect(plan.angleId).toBeNull();
  });

  it("un angleWeights que no cubre los activos GRITA en vez de repartir a ojo", () => {
    // Es la señal de que la transacción de reconcile (§9.4) se rompió.
    // Repartir en silencio escondería ese bug para siempre.
    expect(() =>
      planSuggestion(scriptedRng([0.5]), prefs({ angleWeights: {} }), context()),
    ).toThrow(DomainError);
  });

  it("textStyleWeights vacío deja el preset en null", () => {
    const plan = planSuggestion(
      scriptedRng([0.5]),
      prefs({ textStyleWeights: {} }),
      context(),
    );
    expect(plan.textStylePresetId).toBeNull();
  });

  it("un preset al 100 % fija el look de todas las generaciones", () => {
    const plan = planSuggestion(
      scriptedRng([0.5, 0.5, 0.5, 0.5, 0.5, 0.9]),
      prefs({ textStyleWeights: { "yellow-pop": 100 } }),
      context(),
    );
    expect(plan.textStylePresetId).toBe("yellow-pop");
  });

  it("remixPercentage 0 nunca remixa; 100 siempre", () => {
    expect(
      planSuggestion(
        scriptedRng([0.0, 0.5, 0.5, 0.5, 0.5, 0.5]),
        prefs({ remixPercentage: 0 }),
        context(),
      ).isRemix,
    ).toBe(false);
    expect(
      planSuggestion(
        scriptedRng([0.999999, 0.5, 0.5, 0.5, 0.5, 0.5]),
        prefs({ remixPercentage: 100 }),
        context(),
      ).isRemix,
    ).toBe(true);
  });

  it("el plan devuelve CANDIDATOS de influencer, no un elegido: eso es DP-005", () => {
    const plan = planSuggestion(
      scriptedRng([0.1, 0.1, 0.1, 0.1, 0.1, 0.1]),
      prefs({
        influencerChance: 100,
        slideshowWeight: 100,
        wallOfTextWeight: 0,
        greenScreenWeight: 0,
        videoHookWeight: 0,
      }),
      context([trained({ id: "a" }), trained({ id: "b" })]),
    );
    expect(plan.influencer).toEqual({ decision: "use", candidates: ["a", "b"] });
  });
});
