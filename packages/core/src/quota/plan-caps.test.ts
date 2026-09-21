/**
 * Caps por plan — `EXT-005`, y el `OQ-14` que sigue abierto.
 *
 * La mitad interesante de este archivo es el primer `describe`. El mecanismo
 * funciona; lo que hay que sostener es que **nadie lo llene con números que
 * nadie verificó**, porque en cuanto el número existe la diferencia entre "no
 * lo sabemos" y "lo inventamos" desaparece del código.
 */
import { describe, expect, it } from "vitest";

import {
  assertCanActivateInfluencer,
  assertBatchSize,
} from "../workspace/caps.js";
import { assertCanCreateAngle } from "../angles/angles.js";
import { capsForPlan, HARD_CAPS, PLAN_CAP_OVERRIDES, PLAN_IDS } from "./plans.js";

describe("OQ-14 sigue abierta", () => {
  it("no hay ningún override por plan, y tiene que seguir así", () => {
    // `EXT-005` pide el mecanismo; `OQ-14` dice que los valores exactos por
    // plan se desconocen y que "varían por plan" es una **hipótesis**.
    //
    // Si este test te falla porque agregaste un override: perfecto, pero los
    // tres pasos van juntos — la evidencia, `OQ-14` actualizada en el PRD, y
    // recién ahí este test. Sólo el primero deja el PRD mintiendo.
    expect(PLAN_CAP_OVERRIDES).toEqual({});
  });

  it("por eso todos los planes ven exactamente los mismos caps", () => {
    for (const planId of PLAN_IDS) {
      expect(capsForPlan(planId)).toEqual(HARD_CAPS);
    }
  });
});

describe("capsForPlan", () => {
  it("un override reemplaza sólo el cap nombrado", () => {
    // El override se pasa por parámetro: ejercita el mecanismo sin meter un
    // plan de mentira en la constante compartida.
    const caps = capsForPlan("pro", { pro: { activeInfluencers: 500 } });
    expect(caps.activeInfluencers).toBe(500);
    expect(caps.contentAngles).toBe(HARD_CAPS.contentAngles);
    expect(caps.idsPerBatch).toBe(HARD_CAPS.idsPerBatch);
  });

  it("un plan sin entrada cae en los caps base", () => {
    expect(capsForPlan("free", { pro: { activeInfluencers: 500 } })).toEqual(HARD_CAPS);
  });

  it("no muta `HARD_CAPS`", () => {
    // Un `Object.assign(HARD_CAPS, …)` acá le cambiaría los caps a todo el
    // proceso, y el síntoma aparecería en el workspace de otro tenant.
    capsForPlan("pro", { pro: { activeInfluencers: 500 } });
    expect(HARD_CAPS.activeInfluencers).toBe(50);
  });
});

describe("las aserciones respetan el cap que se les pasa", () => {
  it("con un cap más alto, lo que antes fallaba pasa", () => {
    expect(() => assertCanActivateInfluencer(50)).toThrow();
    expect(() =>
      assertCanActivateInfluencer(50, capsForPlan("pro", { pro: { activeInfluencers: 500 } })),
    ).not.toThrow();
  });

  it("con un cap más bajo, lo que antes pasaba falla", () => {
    // Esta dirección importa más: un mecanismo que sólo sabe subir caps no
    // sirve para un plan free más restringido, que es el caso de uso real.
    expect(() => assertCanCreateAngle(5)).not.toThrow();
    expect(() =>
      assertCanCreateAngle(5, capsForPlan("free", { free: { contentAngles: 5 } })),
    ).toThrow(/up to 5 content angles/);
  });

  it("el mensaje de error lleva el cap efectivo, no el base", () => {
    // Si el mensaje dijera 100 cuando el cap real es 5, el usuario leería una
    // instrucción imposible de cumplir y soporte no sabría de dónde salió.
    expect(() =>
      assertBatchSize(["a", "b", "c"], capsForPlan("free", { free: { idsPerBatch: 2 } })),
    ).toThrow(/up to 2 ids/);
  });
});
