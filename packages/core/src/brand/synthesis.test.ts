import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import { HARD_CAPS } from "../quota/plans.js";
import {
  BRAND_PROFILE_FIELDS,
  GAP_QUESTIONS,
  adviseOnUnansweredGaps,
  gapQuestions,
  materializeField,
  mergeFieldCandidates,
  planLinkFollowing,
  resolveItemsPerAnalysis,
  type DerivedField,
} from "./synthesis.js";

const derived = (over: Partial<DerivedField> = {}): DerivedField => ({
  field: "productOffering",
  value: "Ceramic mugs made in small batches",
  confidence: "high",
  confidenceSource: "verifier",
  excerpt: "small-batch ceramic mugs, made in Valencia",
  sourceId: "bs_1",
  sourceType: "instagram",
  ...over,
});

// ───────────────────────────────────────────────────────────────────────────
// El guardarraíl más importante de la extensión
// ───────────────────────────────────────────────────────────────────────────

describe("NUNCA INVENTAR — un campo sin señal queda vacío (AI-016)", () => {
  it("sin extracto el valor NO se materializa, aunque el modelo diga high", () => {
    // Un `high` sin extracto es el caso peligroso: un modelo seguro de algo
    // que no puede citar. Un PRODUCT OFFERING inventado contamina cada pieza
    // que el sistema genere después.
    const out = materializeField(derived({ excerpt: undefined }));
    expect(out.status).toBe("empty");
    expect(out.value).toBe("");
    expect(out.question).toBe("In one line: what do you actually sell?");
  });

  it("un extracto en blanco cuenta como sin extracto", () => {
    expect(materializeField(derived({ excerpt: "   " })).status).toBe("empty");
  });

  it("un valor en blanco queda vacío, no como cadena rara", () => {
    const out = materializeField(derived({ value: "  " }));
    expect(out.status).toBe("empty");
    expect(out.value).toBe("");
  });

  it("el hueco SIEMPRE genera una pregunta — un vacío mudo es el mismo bug", () => {
    for (const field of BRAND_PROFILE_FIELDS) {
      const out = materializeField(derived({ field, excerpt: undefined }));
      expect(out.question, field).toBe(GAP_QUESTIONS[field]);
      expect(out.question, field).not.toBeNull();
    }
  });

  it("las dos preguntas literales del PRD están tal cual", () => {
    expect(GAP_QUESTIONS.productOffering).toBe("In one line: what do you actually sell?");
    expect(GAP_QUESTIONS.problemSolution).toBe(
      "What problem does someone have right before they find you?",
    );
  });

  it("con extracto y confianza verificada, el campo se materializa", () => {
    const out = materializeField(derived());
    expect(out.status).toBe("materialized");
    expect(out.value).toBe("Ceramic mugs made in small batches");
    expect(out.confidence).toBe("high");
    expect(out.question).toBeNull();
  });
});

describe("la confianza la mide el verificador, no quien derivó el valor (AI-016)", () => {
  it("un high auto-declarado por el sintetizador se recorta a low", () => {
    // "quien deriva un valor no es buen juez de su propia evidencia".
    const out = materializeField(
      derived({ confidence: "high", confidenceSource: "synthesizer" }),
    );
    expect(out.confidence).toBe("low");
    expect(out.status).toBe("needs_review");
  });

  it("recortar NO borra el valor: hay extracto, así que va a revisión", () => {
    const out = materializeField(derived({ confidenceSource: "synthesizer" }));
    expect(out.value).toBe("Ceramic mugs made in small batches");
    expect(out.excerpt).toBeDefined();
    expect(out.question).not.toBeNull();
  });
});

describe("campos low — Worth a quick check (FR-011.2)", () => {
  it("un low verificado se muestra con su valor y su pregunta", () => {
    const out = materializeField(derived({ confidence: "low" }));
    expect(out.status).toBe("needs_review");
    expect(out.value).not.toBe("");
    expect(out.question).not.toBeNull();
  });

  it("gapQuestions junta todo lo que hay que preguntar en el paso de detalles", () => {
    const fields = [
      materializeField(derived({ field: "coreIdentity" })),
      materializeField(derived({ field: "productOffering", excerpt: undefined })),
      materializeField(derived({ field: "problemSolution", confidence: "low" })),
    ];
    expect(gapQuestions(fields)).toEqual([
      GAP_QUESTIONS.productOffering,
      GAP_QUESTIONS.problemSolution,
    ]);
  });
});

describe("si el usuario no responde, el campo queda vacío (FR-011.3)", () => {
  it("no se rellena con nada y se recomienda bajar mentionBusiness", () => {
    const advice = adviseOnUnansweredGaps([
      materializeField(derived({ field: "productOffering", excerpt: undefined })),
      materializeField(derived({ field: "targetAudience" })),
    ]);
    expect(advice.emptyFields).toEqual(["productOffering"]);
    expect(advice.recommendLowMentionBusiness).toBe(true);
  });

  it("un hueco que no es de identidad ni de oferta no cambia la recomendación", () => {
    const advice = adviseOnUnansweredGaps([
      materializeField(derived({ field: "marketAndCompetition", excerpt: undefined })),
    ]);
    expect(advice.recommendLowMentionBusiness).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Fusión — FR-011.6
// ───────────────────────────────────────────────────────────────────────────

describe("precedencia de fusión (FR-011.6)", () => {
  const web = derived({
    field: "coreIdentity",
    value: "desde la web",
    sourceId: "bs_web",
    sourceType: "website",
  });
  const ig = derived({
    field: "coreIdentity",
    value: "desde instagram",
    sourceId: "bs_ig",
    sourceType: "instagram",
  });

  it("website gana a instagram por defecto", () => {
    const out = mergeFieldCandidates("coreIdentity", [ig, web], {
      primarySourceId: null,
    });
    expect(out.field.value).toBe("desde la web");
  });

  it("para toneOfVoice la precedencia se INVIERTE: social gana a la web", () => {
    // El feed dice cómo la marca HABLA en el canal donde vamos a publicar.
    const out = mergeFieldCandidates(
      "toneOfVoice",
      [
        { ...web, field: "toneOfVoice" },
        { ...ig, field: "toneOfVoice" },
      ],
      { primarySourceId: null },
    );
    expect(out.field.value).toBe("desde instagram");
  });

  it("instagram y tiktok EMPATAN: la primaria rompe el empate", () => {
    const tt = derived({
      field: "coreIdentity",
      value: "desde tiktok",
      sourceId: "bs_tt",
      sourceType: "tiktok",
    });
    expect(
      mergeFieldCandidates("coreIdentity", [ig, tt], { primarySourceId: "bs_tt" }).field
        .value,
    ).toBe("desde tiktok");
    expect(
      mergeFieldCandidates("coreIdentity", [ig, tt], { primarySourceId: "bs_ig" }).field
        .value,
    ).toBe("desde instagram");
  });

  it("la primaria rompe el empate pero NO salta un escalón de precedencia", () => {
    // Si la primaria ganara siempre, marcar como primaria una cuenta de X
    // pisaría la web entera. Suma menos que un escalón, a propósito.
    const out = mergeFieldCandidates("coreIdentity", [web, ig], {
      primarySourceId: "bs_ig",
    });
    expect(out.field.value).toBe("desde la web");
  });

  it("dos fuentes que se contradicen: se guarda el conflicto y la confianza baja a medium", () => {
    const out = mergeFieldCandidates("coreIdentity", [web, ig], {
      primarySourceId: null,
    });
    expect(out.conflict).toEqual({
      field: "coreIdentity",
      chosenSourceId: "bs_web",
      otherSourceIds: ["bs_ig"],
    });
    expect(out.field.confidence).toBe("medium");
  });

  it("si coinciden, no hay conflicto y la confianza se conserva", () => {
    const out = mergeFieldCandidates(
      "coreIdentity",
      [web, { ...ig, value: "desde la web" }],
      { primarySourceId: null },
    );
    expect(out.conflict).toBeNull();
    expect(out.field.confidence).toBe("high");
  });

  it("los candidatos sin señal no participan de la fusión", () => {
    const out = mergeFieldCandidates(
      "coreIdentity",
      [{ ...web, excerpt: undefined }, ig],
      { primarySourceId: null },
    );
    expect(out.field.value).toBe("desde instagram");
    expect(out.conflict).toBeNull();
  });

  it("sin ningún candidato usable, el campo queda vacío con su pregunta", () => {
    const out = mergeFieldCandidates("coreIdentity", [], { primarySourceId: null });
    expect(out.field.status).toBe("empty");
    expect(out.field.question).toBe(GAP_QUESTIONS.coreIdentity);
  });
});

describe("una edición manual no se pisa sin permiso (FR-011.6, ERR-B14)", () => {
  it("añadir una fuente propone el cambio en vez de aplicarlo", () => {
    const out = mergeFieldCandidates(
      "coreIdentity",
      [derived({ field: "coreIdentity", value: "lo nuevo" })],
      { primarySourceId: null, editedByUser: true },
    );
    expect(out.awaitingUserDecision).toBe(true);
  });

  it("sin edición manual previa se aplica directo", () => {
    const out = mergeFieldCandidates(
      "coreIdentity",
      [derived({ field: "coreIdentity", value: "lo nuevo" })],
      { primarySourceId: null },
    );
    expect(out.awaitingUserDecision).toBe(false);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Límites de recolección — AI-016, INT-018
// ───────────────────────────────────────────────────────────────────────────

describe("24 ítems por análisis, configurable (AI-016)", () => {
  it("el default es 24", () => {
    expect(HARD_CAPS.itemsPerBrandAnalysis).toBe(24);
    expect(resolveItemsPerAnalysis()).toBe(24);
  });

  it("se puede bajar", () => {
    expect(resolveItemsPerAnalysis(12)).toBe(12);
  });

  it("no se puede pedir 0, ni medio ítem, ni pasarse del techo", () => {
    for (const v of [0, -1, 2.5, 25]) {
      expect(() => resolveItemsPerAnalysis(v), String(v)).toThrow(DomainError);
    }
  });
});

describe("link-in-bio: 1 nivel, 5 destinos, sin recursión (FR-011.11, INT-018)", () => {
  const links = Array.from({ length: 12 }, (_, i) => `https://destino${i}.com`);

  it("sigue como mucho 5 destinos", () => {
    expect(planLinkFollowing(links)).toHaveLength(5);
  });

  it("deduplica antes de contar: 5 destinos distintos, no 5 entradas", () => {
    const dupes = ["https://a.com", "https://A.com ", "https://b.com", "https://a.com"];
    expect(planLinkFollowing(dupes)).toEqual(["https://a.com", "https://b.com"]);
  });

  it("descarta los vacíos", () => {
    expect(planLinkFollowing(["", "   ", "https://a.com"])).toEqual(["https://a.com"]);
  });

  it("la función devuelve destinos, no un árbol: no hay segundo nivel que seguir", () => {
    // "Sin recursión" es la parte que importa: un Linktree que apunta a otro
    // Linktree, seguido en profundidad, es un rastreador de la web entera
    // pegado al alta de un usuario.
    const out = planLinkFollowing(links);
    expect(Array.isArray(out)).toBe(true);
    expect(out.every((l) => typeof l === "string")).toBe(true);
  });
});
