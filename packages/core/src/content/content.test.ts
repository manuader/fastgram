import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import { HARD_CAPS } from "../quota/plans.js";
import type { SavesLedger } from "../quota/content-saves.js";
import {
  ASPECT_RATIOS,
  assertContentInWorkspace,
  assertValidBlitzRequest,
  assertValidSlideCount,
  createBuildingContent,
  markBuildFailed,
  markBuildSucceeded,
  resolveInfluencerForType,
  softDeleteContent,
  type Content,
} from "./content.js";
import {
  BACKGROUND_STYLES,
  FONT_WEIGHTS,
  TEXT_BOX_LIMITS,
  assertNoUnknownFields,
  assertValidRegenerationPrompt,
  assertValidTextBoxes,
  type ContentTextBox,
} from "./text-boxes.js";

const box = (over: Partial<ContentTextBox> = {}): ContentTextBox => ({
  id: "slide-0-text-0",
  text: "Consistency without burnout",
  position: { x: 50, y: 70 },
  widthPercent: 80,
  font: { family: "montserrat", weight: 600, size: 18 },
  color: "#FFFFFF",
  stroke: { width: 3, color: "#000000" },
  background: null,
  ...over,
});

const ledger = (over: Partial<SavesLedger> = {}): SavesLedger => ({
  plan: "starter",
  includedUsed: 5,
  purchasedRemaining: 2,
  overageUsed: 0,
  overageEnabled: false,
  resetAt: new Date("2026-10-01T00:00:00Z"),
  ...over,
});

const piece = (over: Partial<Content> = {}): Content =>
  ({
    ...createBuildingContent({
      id: "cnt_1",
      companyId: "co_1",
      type: "slideshow",
      saveBucket: "included",
      textBoxes: [box()],
      slideCount: 3,
    }),
    ...over,
  }) as Content;

const NOW = new Date("2026-09-21T10:00:00Z");

// ───────────────────────────────────────────────────────────────────────────
// FR-051 · Validation — los números literales del PRD
// ───────────────────────────────────────────────────────────────────────────

describe("cajas de texto — rangos literales de FR-051 y DATA-009", () => {
  it("text acepta vacío y hasta 5 000 caracteres, no 5 001", () => {
    expect(() => assertValidTextBoxes([box({ text: "" })])).not.toThrow();
    expect(() =>
      assertValidTextBoxes([box({ text: "a".repeat(TEXT_BOX_LIMITS.textMaxChars) })]),
    ).not.toThrow();
    expect(() =>
      assertValidTextBoxes([box({ text: "a".repeat(TEXT_BOX_LIMITS.textMaxChars + 1) })]),
    ).toThrow(DomainError);
  });

  it("position.x e y viven en [0, 100], bordes incluidos", () => {
    expect(() =>
      assertValidTextBoxes([box({ position: { x: 0, y: 100 } })]),
    ).not.toThrow();
    expect(() => assertValidTextBoxes([box({ position: { x: -1, y: 0 } })])).toThrow(
      DomainError,
    );
    expect(() => assertValidTextBoxes([box({ position: { x: 0, y: 101 } })])).toThrow(
      DomainError,
    );
  });

  it("widthPercent vive en [25, 100] — 24 es el error clásico", () => {
    expect(() => assertValidTextBoxes([box({ widthPercent: 25 })])).not.toThrow();
    expect(() => assertValidTextBoxes([box({ widthPercent: 100 })])).not.toThrow();
    expect(() => assertValidTextBoxes([box({ widthPercent: 24 })])).toThrow(DomainError);
    expect(() => assertValidTextBoxes([box({ widthPercent: 101 })])).toThrow(DomainError);
  });

  it("font.size vive en [8, 72]", () => {
    for (const size of [8, 72]) {
      expect(() =>
        assertValidTextBoxes([box({ font: { family: "inter", weight: 400, size } })]),
      ).not.toThrow();
    }
    for (const size of [7, 73]) {
      expect(() =>
        assertValidTextBoxes([box({ font: { family: "inter", weight: 400, size } })]),
      ).toThrow(DomainError);
    }
  });

  it("stroke.width vive en [0, 8]", () => {
    expect(() =>
      assertValidTextBoxes([box({ stroke: { width: 0, color: "#000000" } })]),
    ).not.toThrow();
    expect(() =>
      assertValidTextBoxes([box({ stroke: { width: 8, color: "#000000" } })]),
    ).not.toThrow();
    expect(() =>
      assertValidTextBoxes([box({ stroke: { width: 9, color: "#000000" } })]),
    ).toThrow(DomainError);
  });

  it("los colores son #RRGGBB y nada más", () => {
    expect(() => assertValidTextBoxes([box({ color: "#fff" })])).toThrow(DomainError);
    expect(() => assertValidTextBoxes([box({ color: "white" })])).toThrow(DomainError);
    expect(() => assertValidTextBoxes([box({ color: "rgba(255,255,255,1)" })])).toThrow(
      DomainError,
    );
    expect(() => assertValidTextBoxes([box({ color: "#AaBbCc" })])).not.toThrow();
  });

  it("background.opacity vive en [0, 1] y el estilo es pill o full-width", () => {
    for (const style of BACKGROUND_STYLES) {
      expect(() =>
        assertValidTextBoxes([
          box({ background: { color: "#FFFFFF", opacity: 1, style } }),
        ]),
      ).not.toThrow();
    }
    expect(() =>
      assertValidTextBoxes([
        box({ background: { color: "#FFFFFF", opacity: 1.1, style: "pill" } }),
      ]),
    ).toThrow(DomainError);
    expect(() =>
      assertValidTextBoxes([
        box({
          background: {
            color: "#FFFFFF",
            opacity: 1,
            // Valor fuera del enum del PRD.
            style: "rounded" as never,
          },
        }),
      ]),
    ).toThrow(DomainError);
  });

  it("background: null es válido — el PRD dice que ELIMINA el fondo", () => {
    expect(() => assertValidTextBoxes([box({ background: null })])).not.toThrow();
  });
});

describe("familias tipográficas — la tabla NO es uniforme (FR-051)", () => {
  it("las seis primeras aceptan 300–700 en pasos de 100", () => {
    for (const family of [
      "tiktok",
      "snapchat",
      "montserrat",
      "poppins",
      "inter",
      "oswald",
    ] as const) {
      expect(FONT_WEIGHTS[family]).toEqual([300, 400, 500, 600, 700]);
      for (const weight of [300, 400, 500, 600, 700]) {
        expect(() =>
          assertValidTextBoxes([box({ font: { family, weight, size: 18 } })]),
        ).not.toThrow();
      }
    }
  });

  it("playfair y caveat arrancan en 400: 300 se rechaza", () => {
    for (const family of ["playfair", "caveat"] as const) {
      expect(() =>
        assertValidTextBoxes([box({ font: { family, weight: 400, size: 18 } })]),
      ).not.toThrow();
      expect(() =>
        assertValidTextBoxes([box({ font: { family, weight: 300, size: 18 } })]),
      ).toThrow(DomainError);
    }
  });

  it("anton, bebas, bangers y pacifico SÓLO tienen 400", () => {
    for (const family of ["anton", "bebas", "bangers", "pacifico"] as const) {
      expect(FONT_WEIGHTS[family]).toEqual([400]);
      expect(() =>
        assertValidTextBoxes([box({ font: { family, weight: 400, size: 18 } })]),
      ).not.toThrow();
      for (const weight of [300, 500, 700]) {
        expect(() =>
          assertValidTextBoxes([box({ font: { family, weight, size: 18 } })]),
        ).toThrow(DomainError);
      }
    }
  });

  it("una familia fuera del catálogo se rechaza", () => {
    expect(() =>
      assertValidTextBoxes([
        box({ font: { family: "comic-sans" as never, weight: 400, size: 18 } }),
      ]),
    ).toThrow(DomainError);
  });
});

describe("el conjunto de cajas", () => {
  it("textBoxes vacío se rechaza — para quitar el texto se usa text: ''", () => {
    expect(() => assertValidTextBoxes([])).toThrow(DomainError);
  });

  it("los ids duplicados se rechazan", () => {
    expect(() => assertValidTextBoxes([box(), box()])).toThrow(DomainError);
  });

  it("un campo desconocido se rechaza", () => {
    expect(() =>
      assertNoUnknownFields({ id: "a", status: "CREATED" }, ["id"], "patch"),
    ).toThrow(DomainError);
  });

  it("el prompt de regeneración tope en 500 caracteres", () => {
    expect(() => assertValidRegenerationPrompt("a".repeat(500))).not.toThrow();
    expect(() => assertValidRegenerationPrompt("a".repeat(501))).toThrow(DomainError);
    expect(() => assertValidRegenerationPrompt(undefined)).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// FR-050 · Validation
// ───────────────────────────────────────────────────────────────────────────

describe("assertValidBlitzRequest — FR-050", () => {
  it("acepta los cuatro tipos de Blitz y rechaza custom", () => {
    for (const contentType of [
      "slideshow",
      "wall-of-text",
      "green-screen",
      "video-hook",
    ]) {
      expect(() => assertValidBlitzRequest({ contentType })).not.toThrow();
    }
    expect(() => assertValidBlitzRequest({ contentType: "custom" })).toThrow(DomainError);
    expect(() => assertValidBlitzRequest({ contentType: "carousel" })).toThrow(
      DomainError,
    );
  });

  it("aspectRatio SÓLO aplica a slideshow", () => {
    for (const aspectRatio of ASPECT_RATIOS) {
      expect(() =>
        assertValidBlitzRequest({ contentType: "slideshow", aspectRatio }),
      ).not.toThrow();
    }
    // Un aspectRatio en wall-of-text no rompe el render: lo ignora. Por eso
    // hay que rechazarlo — si no, el usuario cree que eligió y no eligió.
    expect(() =>
      assertValidBlitzRequest({ contentType: "wall-of-text", aspectRatio: "4:5" }),
    ).toThrow(DomainError);
  });

  it("un aspectRatio fuera del enum se rechaza", () => {
    expect(() =>
      assertValidBlitzRequest({ contentType: "slideshow", aspectRatio: "16:9" }),
    ).toThrow(DomainError);
  });
});

describe("slides por slideshow — cap de 20 (§16.2)", () => {
  it("20 pasa, 21 no", () => {
    expect(HARD_CAPS.slidesPerSlideshow).toBe(20);
    expect(() => assertValidSlideCount("slideshow", 20)).not.toThrow();
    expect(() => assertValidSlideCount("slideshow", 21)).toThrow(DomainError);
  });

  it("los formatos de una sola superficie tienen exactamente 1 slide", () => {
    expect(() => assertValidSlideCount("wall-of-text", 1)).not.toThrow();
    expect(() => assertValidSlideCount("wall-of-text", 2)).toThrow(DomainError);
  });

  it("0 slides no es una pieza", () => {
    expect(() => assertValidSlideCount("slideshow", 0)).toThrow(DomainError);
  });
});

describe("resolveInfluencerForType — degrada, no falla (FR-050 · FR-055 regla 5)", () => {
  const trained = { id: "inf_1", isActive: true, isTrained: true };

  it("green-screen NUNCA lleva influencer, aunque esté entrenado y activo", () => {
    expect(resolveInfluencerForType("green-screen", trained)).toBeUndefined();
  });

  it("un influencer sin entrenar cae a contenido regular en vez de fallar", () => {
    expect(
      resolveInfluencerForType("slideshow", { ...trained, isTrained: false }),
    ).toBeUndefined();
    expect(
      resolveInfluencerForType("slideshow", { ...trained, isActive: false }),
    ).toBeUndefined();
  });

  it("entrenado y activo, en un formato que lo admite, se usa", () => {
    for (const type of ["slideshow", "wall-of-text", "video-hook"] as const) {
      expect(resolveInfluencerForType(type, trained)).toBe("inf_1");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Ciclo de vida — DATA-008
// ───────────────────────────────────────────────────────────────────────────

describe("ciclo de vida BUILDING → CREATED | FAILED", () => {
  it("nace en BUILDING con revision 0 y sin archivos", () => {
    const c = piece();
    expect(c.status).toBe("BUILDING");
    expect(c.revision).toBe(0);
    expect(c.files).toEqual([]);
    expect(c.saveRefundedAt).toBeUndefined();
  });

  it("un build exitoso pasa a CREATED y guarda los archivos", () => {
    const done = markBuildSucceeded(piece(), {
      files: ["a.jpg", "b.jpg", "c.jpg"],
      thumbnailUrl: "t.jpg",
    });
    expect(done.status).toBe("CREATED");
    expect(done.files).toHaveLength(3);
    expect(done.revision).toBe(0);
  });

  it("un build que no produce archivos no es un build exitoso", () => {
    expect(() => markBuildSucceeded(piece(), { files: [] })).toThrow(DomainError);
  });

  it("una pieza ya CREATED no puede volver a terminar de construir", () => {
    const done = markBuildSucceeded(piece(), { files: ["a.jpg"] });
    expect(() => markBuildSucceeded(done, { files: ["b.jpg"] })).toThrow(DomainError);
  });
});

describe("un build fallido REEMBOLSA el content save (FR-050, criterio 2)", () => {
  it("devuelve el save al bucket del que salió — included", () => {
    const before = ledger({ includedUsed: 6 });
    const out = markBuildFailed(piece({ saveBucket: "included" }), before, "render", NOW);
    expect(out.content.status).toBe("FAILED");
    expect(out.refunded).toBe(true);
    expect(out.saves.includedUsed).toBe(5);
    expect(out.saves.purchasedRemaining).toBe(before.purchasedRemaining);
  });

  it("devuelve el save al bucket del que salió — purchased, NO a included", () => {
    // Reembolsar siempre a `included` le regala al cliente un save que caduca
    // y le come uno permanente. Es el bug que `saveBucket` existe para evitar.
    const before = ledger({ includedUsed: 20, purchasedRemaining: 3 });
    const out = markBuildFailed(piece({ saveBucket: "purchased" }), before, "x", NOW);
    expect(out.saves.purchasedRemaining).toBe(4);
    expect(out.saves.includedUsed).toBe(20);
  });

  it("devuelve el save al bucket del que salió — overage", () => {
    const before = ledger({ overageUsed: 2, overageEnabled: true });
    const out = markBuildFailed(piece({ saveBucket: "overage" }), before, "x", NOW);
    expect(out.saves.overageUsed).toBe(1);
  });

  it("el reembolso es IDEMPOTENTE: el handler de la cola puede reintentarse", () => {
    // El puerto Queue dice que el handler debe ser idempotente. Sin guarda,
    // cada reintento sería un save gratis.
    const before = ledger({ includedUsed: 6 });
    const first = markBuildFailed(piece(), before, "render", NOW);
    const second = markBuildFailed(first.content, first.saves, "render", NOW);

    expect(first.refunded).toBe(true);
    expect(second.refunded).toBe(false);
    expect(second.saves.includedUsed).toBe(5);
    expect(second.content.status).toBe("FAILED");
  });

  it("una pieza que ya construyó bien no puede 'fallar el build'", () => {
    const done = markBuildSucceeded(piece(), { files: ["a.jpg"] });
    expect(() => markBuildFailed(done, ledger(), "x", NOW)).toThrow(DomainError);
  });
});

describe("borrar NO devuelve el content save (DATA-008, §16.2)", () => {
  it("el soft-delete sólo marca deletedAt — ni siquiera recibe un ledger", () => {
    const done = markBuildSucceeded(piece(), { files: ["a.jpg"] });
    const deleted = softDeleteContent(done, NOW);
    expect(deleted.deletedAt).toEqual(NOW);
    expect(deleted.saveRefundedAt).toBeUndefined();
  });

  it("borrar dos veces no cambia la fecha", () => {
    const deleted = softDeleteContent(piece(), NOW);
    const again = softDeleteContent(deleted, new Date("2027-01-01T00:00:00Z"));
    expect(again.deletedAt).toEqual(NOW);
  });
});

describe("acceso cruzado — 404, nunca 403 (§9.2)", () => {
  it("una pieza de otro workspace es not_found", () => {
    const c = piece({ companyId: "co_otro" });
    try {
      assertContentInWorkspace(c, "co_1", "usr_curioso");
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError);
      const err = e as DomainError;
      expect(err.code).toBe("not_found");
      // Hacia afuera no se distingue de un id inexistente...
      expect(err.toPublic().message).toBe("content not found");
      // ...pero adentro queda registrado que fue un intento cruzado.
      expect(err.details?.crossTenant).toBe(true);
      expect(err.details?.attemptedBy).toBe("usr_curioso");
    }
  });

  it("la propia pasa sin ruido", () => {
    expect(() => assertContentInWorkspace(piece(), "co_1", "usr_1")).not.toThrow();
  });
});
