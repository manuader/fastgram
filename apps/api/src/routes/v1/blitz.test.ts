/**
 * Lo de Blitz que se puede afirmar **sin** base de datos.
 *
 * Todo lo que toca Postgres —el reconcile dentro de la transacción, el rollback, la
 * desactivación del DELETE— vive en `test/blitz-angles.int.test.ts`, porque ahí lo que
 * se prueba es precisamente el comportamiento transaccional y un doble en memoria lo
 * daría por bueno por construcción.
 *
 * Acá quedan dos cosas que sí se pueden fijar solas: los defaults sintetizados de
 * DATA-006 y la forma del envelope de la paginación numerada, que es una **decisión**
 * (el PRD nombra `GET /blitz/angles/page` pero no detalla su respuesta) y por eso
 * necesita un test que la vuelva deliberada en vez de accidental.
 */
import { describe, expect, it } from "vitest";
import {
  CONTENT_MIX_WEIGHT_SUM,
  INFLUENCER_CHANCE_DEFAULT,
  SMART_TEXT_POSITIONING_DEFAULT,
} from "@fastgram/contracts";

import { numberedPageEnvelope } from "./angles.js";
import { DEFAULT_BLITZ_PREFERENCES, SETTINGS_APPLICATION, activeAngleIdsOf } from "./blitz.js";

describe("DEFAULT_BLITZ_PREFERENCES · DATA-006", () => {
  it("los cuatro pesos de formato suman 100, que es lo único que el PRD exige", () => {
    const sum =
      DEFAULT_BLITZ_PREFERENCES.slideshowWeight +
      DEFAULT_BLITZ_PREFERENCES.wallOfTextWeight +
      DEFAULT_BLITZ_PREFERENCES.greenScreenWeight +
      DEFAULT_BLITZ_PREFERENCES.videoHookWeight;
    expect(sum).toBe(CONTENT_MIX_WEIGHT_SUM);
  });

  it("los dos números que sí están en el PRD son los del PRD", () => {
    expect(DEFAULT_BLITZ_PREFERENCES.influencerChance).toBe(INFLUENCER_CHANCE_DEFAULT);
    expect(DEFAULT_BLITZ_PREFERENCES.smartTextPositioning).toBe(
      SMART_TEXT_POSITIONING_DEFAULT,
    );
  });

  it("los tres porcentajes opt-in arrancan en 0", () => {
    expect(DEFAULT_BLITZ_PREFERENCES.remixPercentage).toBe(0);
    expect(DEFAULT_BLITZ_PREFERENCES.ownMediaPercentage).toBe(0);
    expect(DEFAULT_BLITZ_PREFERENCES.mentionBusinessPercentage).toBe(0);
  });

  it("`settingsApplication` es la constante de FR-055, no estado guardado", () => {
    expect(SETTINGS_APPLICATION).toEqual({
      mode: "future_generations",
      targetQueuedItems: 5,
    });
  });
});

describe("activeAngleIdsOf", () => {
  it("conserva el orden de entrada, que es el que decide quién se queda el resto", () => {
    const rows = [
      { id: "c", isActive: true },
      { id: "b", isActive: false },
      { id: "a", isActive: true },
    ];
    expect(activeAngleIdsOf(rows)).toEqual(["c", "a"]);
  });
});

describe("envelope de `GET /blitz/angles/page` · §9.3 + §9.10", () => {
  const source = {
    items: [{ n: 1 }, { n: 2 }],
    page: 2,
    pageSize: 2,
    totalItems: 5,
    totalPages: 3,
    hasMore: true,
  };

  it("mantiene las dos claves de primer nivel que fija §9.3", () => {
    expect(Object.keys(numberedPageEnvelope(source, (row) => row.n))).toEqual([
      "data",
      "pagination",
    ]);
  });

  it("lleva lo que `Page X of Y` necesita", () => {
    const out = numberedPageEnvelope(source, (row) => row.n);
    expect(out.data).toEqual([1, 2]);
    expect(out.pagination).toEqual({
      page: 2,
      pageSize: 2,
      totalItems: 5,
      totalPages: 3,
      hasMore: true,
    });
  });

  it("NO trae `cursor`: esta ruta no acepta ninguno y un null permanente invita a un bug", () => {
    expect(numberedPageEnvelope(source, (row) => row.n).pagination).not.toHaveProperty(
      "cursor",
    );
  });
});
