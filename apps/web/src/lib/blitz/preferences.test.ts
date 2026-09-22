/**
 * El cuerpo del PATCH · FR-055 Validation (PRD:1292).
 *
 * `buildPreferencesPatch` es donde se cumplen o se rompen las tres reglas de
 * conjunto que el servidor hace valer con un `400`. Los casos de acá son
 * exactamente los que el servidor rechaza: un set parcial de los cuatro pesos,
 * un cuerpo vacío y `settingsApplication` en el patch.
 */
import { blitzPreferencesSchema, type BlitzPreferences } from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import { buildPreferencesPatch, toDraft, type PreferencesDraft } from "./preferences";

/**
 * Una respuesta **validada contra el contrato**, no un literal con un `as`
 * encima: un fixture que el servidor nunca devolvería produce un test verde
 * sobre un caso que no existe.
 */
function prefs(overrides: Readonly<Record<string, unknown>> = {}): BlitzPreferences {
  return blitzPreferencesSchema.parse({
    slideshowWeight: 25,
    wallOfTextWeight: 25,
    greenScreenWeight: 25,
    videoHookWeight: 25,
    remixPercentage: 0,
    ownMediaPercentage: 0,
    mentionBusinessPercentage: 0,
    influencerChance: 50,
    smartTextPositioning: true,
    genderFilter: null,
    angleWeights: {},
    textStyleWeights: {},
    settingsApplication: { mode: "future_generations", targetQueuedItems: 5 },
    ...overrides,
  });
}

function draft(overrides: Readonly<Record<string, unknown>> = {}): PreferencesDraft {
  return toDraft(prefs(overrides));
}

describe("nada que guardar", () => {
  it("dos estados iguales no producen patch", () => {
    // Body vacío `{}` es `400` (FR-055 Validation): mandarlo sería enseñar un
    // error por no haber cambiado nada.
    expect(buildPreferencesPatch(draft(), draft()).patch).toBeNull();
  });

  it("revertir un cambio lo saca del patch en vez de mandarlo de vuelta", () => {
    const baseline = draft();
    const wentAndCameBack = draft({ influencerChance: 50 });
    expect(buildPreferencesPatch(baseline, wentAndCameBack).patch).toBeNull();
  });
});

describe("los cuatro pesos, como unidad", () => {
  it("cambiar UNO manda los CUATRO", () => {
    // Es la regla entera: un set parcial es `400` aunque los valores sean
    // correctos, porque el servidor no decide a quién le quita los puntos.
    const { patch } = buildPreferencesPatch(
      draft(),
      draft({
        slideshowWeight: 40,
        wallOfTextWeight: 20,
        greenScreenWeight: 20,
        videoHookWeight: 20,
      }),
    );
    expect(patch).toEqual({
      slideshowWeight: 40,
      wallOfTextWeight: 20,
      greenScreenWeight: 20,
      videoHookWeight: 20,
    });
  });

  it("si el mix no suma 100 NO se manda, y se dice cuál quedó bloqueado", () => {
    // La UI no debería poder llegar aquí —`setWeight` mantiene la suma— así que
    // esto es la red: el día que alguien añada un control que no pase por
    // `setWeight`, el fallo es "no se guardó y se ve", no un `400` por
    // arrastre.
    const invalid = draft({
      slideshowWeight: 40,
      wallOfTextWeight: 25,
      greenScreenWeight: 25,
      videoHookWeight: 25,
    });
    const result = buildPreferencesPatch(draft(), invalid);
    expect(result.patch).toBeNull();
    expect(result.blocked).toEqual(["contentMix"]);
  });

  it("un mix bloqueado no arrastra consigo a los campos que sí son válidos", () => {
    const mixed = draft({
      slideshowWeight: 40,
      wallOfTextWeight: 25,
      greenScreenWeight: 25,
      videoHookWeight: 25,
      remixPercentage: 30,
    });
    const result = buildPreferencesPatch(draft(), mixed);
    expect(result.patch).toEqual({ remixPercentage: 30 });
    expect(result.blocked).toEqual(["contentMix"]);
  });
});

describe("campos sueltos", () => {
  it("manda sólo lo que cambió", () => {
    const { patch } = buildPreferencesPatch(draft(), draft({ influencerChance: 80 }));
    expect(patch).toEqual({ influencerChance: 80 });
  });

  it("`genderFilter: null` es un valor y viaja; no se confunde con una ausencia", () => {
    // Con un `patch.genderFilter ?? base` el usuario no podría quitar nunca el
    // filtro: el `null` se descartaría y la pantalla enseñaría "sin filtro"
    // mientras el servidor sigue filtrando.
    const { patch } = buildPreferencesPatch(
      draft({ genderFilter: "woman" }),
      draft({ genderFilter: null }),
    );
    expect(patch).toEqual({ genderFilter: null });
  });

  it("`smartTextPositioning: false` viaja aunque sea falsy", () => {
    const { patch } = buildPreferencesPatch(
      draft(),
      draft({ smartTextPositioning: false }),
    );
    expect(patch).toEqual({ smartTextPositioning: false });
  });
});

describe("textStyleWeights", () => {
  it("apagar el mix manda `{}`, que es lo que lo desactiva", () => {
    const on = draft({ textStyleWeights: { "tiktok-classic": 100 } });
    const { patch } = buildPreferencesPatch(on, draft({ textStyleWeights: {} }));
    expect(patch).toEqual({ textStyleWeights: {} });
  });

  it("encenderlo manda el reparto entero", () => {
    const { patch } = buildPreferencesPatch(
      draft(),
      draft({ textStyleWeights: { "tiktok-classic": 60, snapchat: 40 } }),
    );
    expect(patch).toEqual({
      textStyleWeights: { "tiktok-classic": 60, snapchat: 40 },
    });
  });
});

describe("lo que nunca puede salir en un patch", () => {
  it("`settingsApplication` no está, ni cuando cambia", () => {
    // FR-055 regla 7: es sólo de respuesta y mandarlo es `400`. Como el
    // borrador ni siquiera lo tiene (`toDraft` lo quita), no hay camino por el
    // que pueda colarse — y este test es lo que fija esa propiedad.
    const before = draft();
    const after = draft({ influencerChance: 70 });
    const { patch } = buildPreferencesPatch(before, after);
    expect(patch).not.toBeNull();
    expect(Object.keys(patch ?? {})).not.toContain("settingsApplication");
  });

  it("`angleWeights` tampoco, porque esta pantalla no lo edita", () => {
    // Su regla es cubrir todos los ángulos activos del workspace y la pantalla
    // no tiene esa lista: mandarlo sería un `400` garantizado.
    const { patch } = buildPreferencesPatch(
      draft({ angleWeights: { "angle-1": 100 } }),
      draft({ angleWeights: {}, influencerChance: 10 }),
    );
    expect(patch).toEqual({ influencerChance: 10 });
  });
});
