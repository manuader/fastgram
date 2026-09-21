import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import {
  ANGLE_ERROR_CODES,
  ANGLE_FIELD_LIMITS,
  activateAngle,
  assertAngleIsActiveForLinking,
  assertCanCreateAngle,
  assertCanLinkInfluencer,
  assertValidAngleWeights,
  assertValidInfluencerLinks,
  deactivateAngle,
  editAngleText,
  reconcileAngleWeights,
  type ContentAngle,
} from "./angles.js";

const angle = (over: Partial<ContentAngle> = {}): ContentAngle => ({
  id: "ang_1",
  title: "Consistency Without Burnout",
  description: "Highlights how non-marketers can now produce high-quality content.",
  targetAudience: "Solo founders",
  isActive: true,
  influencerIds: [],
  ...over,
});

describe("reconcileAngleWeights — suma exactamente 100 (PRD FR-055)", () => {
  it("el ejemplo literal del PRD: 3 ángulos → 34/33/33", () => {
    // La implementación ingenua da 33/33/33 y suma 99. El PRD pone este
    // ejemplo justamente porque es donde se nota.
    expect(reconcileAngleWeights(["a", "b", "c"])).toEqual({ a: 34, b: 33, c: 33 });
  });

  it("suma 100 para cualquier cantidad de ángulos, hasta el cap", () => {
    for (let n = 1; n <= 100; n++) {
      const ids = Array.from({ length: n }, (_, i) => `a${i}`);
      const w = reconcileAngleWeights(ids);
      const sum = Object.values(w).reduce((a, b) => a + b, 0);
      expect(sum, `con ${n} ángulos`).toBe(100);
      expect(Object.keys(w)).toHaveLength(n);
    }
  });

  it("reparte el resto entre los primeros", () => {
    // 100/7 = 14 resto 2 → los dos primeros llevan uno más.
    expect(reconcileAngleWeights(["a", "b", "c", "d", "e", "f", "g"])).toEqual({
      a: 15,
      b: 15,
      c: 14,
      d: 14,
      e: 14,
      f: 14,
      g: 14,
    });
  });

  it("un solo ángulo se lleva todo", () => {
    expect(reconcileAngleWeights(["a"])).toEqual({ a: 100 });
  });

  it("sin ángulos activos el mapa se LIMPIA", () => {
    // No queda un peso huérfano apuntando a un ángulo que ya no compite.
    expect(reconcileAngleWeights([])).toEqual({});
  });

  it("ningún peso queda en negativo ni fraccionario", () => {
    for (let n = 1; n <= 100; n++) {
      const ids = Array.from({ length: n }, (_, i) => `a${i}`);
      for (const w of Object.values(reconcileAngleWeights(ids))) {
        expect(Number.isInteger(w)).toBe(true);
        expect(w).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe("assertValidAngleWeights — el PATCH explícito del usuario", () => {
  it("acepta un mapa que cubre todos los activos y suma 100", () => {
    expect(() => assertValidAngleWeights({ a: 50, b: 50 }, ["a", "b"])).not.toThrow();
  });

  it("rechaza si no cubre todos los activos", () => {
    expect(() => assertValidAngleWeights({ a: 100 }, ["a", "b"])).toThrow(
      /every active angle/,
    );
  });

  it("rechaza si referencia un ángulo inactivo o ajeno", () => {
    expect(() => assertValidAngleWeights({ a: 50, z: 50 }, ["a"])).toThrow(/not active/);
  });

  it("rechaza si no suma 100", () => {
    expect(() =>
      assertValidAngleWeights({ a: 33, b: 33, c: 33 }, ["a", "b", "c"]),
    ).toThrow(/add up to 100/);
  });

  it("rechaza pesos fraccionarios o negativos", () => {
    expect(() => assertValidAngleWeights({ a: 50.5, b: 49.5 }, ["a", "b"])).toThrow(
      /whole number/,
    );
    expect(() => assertValidAngleWeights({ a: 110, b: -10 }, ["a", "b"])).toThrow(
      /whole number/,
    );
  });

  it("lo que produce reconcile siempre pasa la validación", () => {
    // Invariante que une las dos mitades: si reconcile produjera algo que la
    // validación rechaza, el sistema se autobloquearía.
    for (let n = 1; n <= 50; n++) {
      const ids = Array.from({ length: n }, (_, i) => `a${i}`);
      expect(() =>
        assertValidAngleWeights(reconcileAngleWeights(ids), ids),
      ).not.toThrow();
    }
  });
});

describe("caps del PRD FR-056", () => {
  it("100 ángulos por workspace, con el código literal del PRD", () => {
    expect(() => assertCanCreateAngle(99)).not.toThrow();
    try {
      assertCanCreateAngle(100);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).details?.["code"]).toBe(ANGLE_ERROR_CODES.maxAngles);
      expect(ANGLE_ERROR_CODES.maxAngles).toBe("MAX_ANGLES_EXCEEDED");
    }
  });

  it("10 ángulos por influencer, con su código propio", () => {
    expect(() => assertCanLinkInfluencer("inf_1", 9)).not.toThrow();
    try {
      assertCanLinkInfluencer("inf_1", 10);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).details?.["code"]).toBe(
        "MAX_ANGLES_PER_INFLUENCER_EXCEEDED",
      );
    }
  });

  it("los límites de campo son los del PRD", () => {
    expect(ANGLE_FIELD_LIMITS).toEqual({
      title: 200,
      description: 2000,
      targetAudience: 500,
    });
  });

  it("un título de 201 caracteres se rechaza; 200 pasa", () => {
    const w = { ang_1: 100 };
    expect(() => editAngleText(angle(), { title: "x".repeat(200) }, w)).not.toThrow();
    expect(() => editAngleText(angle(), { title: "x".repeat(201) }, w)).toThrow(
      /200 characters/,
    );
  });
});

describe("enlaces de influencer", () => {
  const plantel = [
    { id: "inf_ok", isActive: true, isTrained: true },
    { id: "inf_sin_entrenar", isActive: true, isTrained: false },
    { id: "inf_inactivo", isActive: false, isTrained: true },
  ];

  it("acepta influencers activos y entrenados", () => {
    expect(() => assertValidInfluencerLinks(["inf_ok"], plantel)).not.toThrow();
  });

  it("rechaza ids duplicados", () => {
    expect(() => assertValidInfluencerLinks(["inf_ok", "inf_ok"], plantel)).toThrow(
      /unique/,
    );
  });

  it("rechaza uno sin entrenar", () => {
    // Enlazarlo crearía un ángulo que nunca se puede usar, y el usuario lo
    // descubriría recién al ver que ese ángulo no sale nunca.
    expect(() => assertValidInfluencerLinks(["inf_sin_entrenar"], plantel)).toThrow(
      /trained/,
    );
  });

  it("rechaza uno inactivo", () => {
    expect(() => assertValidInfluencerLinks(["inf_inactivo"], plantel)).toThrow(/active/);
  });

  it("uno de otro workspace es not_found, no forbidden", () => {
    // No confirmamos que el id existe en otra cuenta (PRD §9.2).
    try {
      assertValidInfluencerLinks(["inf_de_otro"], plantel);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).code).toBe("not_found");
    }
  });

  it("asignar influencers a un ángulo inactivo se rechaza", () => {
    expect(() => assertAngleIsActiveForLinking(angle({ isActive: false }))).toThrow(
      /Activate/,
    );
  });
});

describe("transiciones", () => {
  it("desactivar borra los enlaces de influencer y reactivar NO los restaura", () => {
    // Regla explícita del PRD y contraintuitiva: parece que desactivar
    // debería ser del todo reversible. No lo es.
    const conEnlaces = angle({ influencerIds: ["inf_1", "inf_2"] });

    const desactivado = deactivateAngle(conEnlaces, ["ang_2"]);
    expect(desactivado.angle.isActive).toBe(false);
    expect(desactivado.angle.influencerIds).toEqual([]);

    const reactivado = activateAngle(desactivado.angle, ["ang_2"]);
    expect(reactivado.angle.isActive).toBe(true);
    expect(reactivado.angle.influencerIds).toEqual([]);
  });

  it("desactivar reparte los pesos entre los que quedan", () => {
    const r = deactivateAngle(angle(), ["ang_2", "ang_3"]);
    expect(r.weights).toEqual({ ang_2: 50, ang_3: 50 });
    expect(r.weightsChanged).toBe(true);
  });

  it("desactivar el último ángulo limpia el mapa", () => {
    expect(deactivateAngle(angle(), []).weights).toEqual({});
  });

  it("reactivar incluye al ángulo en el reparto", () => {
    const r = activateAngle(angle({ isActive: false }), ["ang_2", "ang_3"]);
    expect(r.weights).toEqual({ ang_2: 34, ang_3: 33, ang_1: 33 });
  });

  it("editar el texto NO dispara reconcile", () => {
    // Si lo disparara, corregir una falta de ortografía borraría los pesos
    // personalizados que el usuario puso a mano.
    const personalizados = { ang_1: 70, ang_2: 30 };
    const r = editAngleText(angle(), { title: "Nuevo título" }, personalizados);

    expect(r.weightsChanged).toBe(false);
    expect(r.weights).toEqual(personalizados);
    expect(r.angle.title).toBe("Nuevo título");
  });
});
