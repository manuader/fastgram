import { describe, expect, it } from "vitest";
import { DomainError } from "../errors.js";
import {
  CONTENT_ERROR_CODES,
  createBuildingContent,
  markBuildSucceeded,
  type Content,
} from "./content.js";
import {
  applyMinorEdit,
  applyRegeneratedCopy,
  assertContentEditable,
  assertRevisionMatches,
  markEditRebuildFailed,
  markEditRebuildSucceeded,
} from "./edit-content.js";
import type { ContentTextBox } from "./text-boxes.js";

const NOW = new Date("2026-09-21T10:00:00Z");

const box = (id: string, slideIndex: number): ContentTextBox => ({
  id,
  slideIndex,
  text: `copy ${id}`,
  position: { x: 50, y: 70 },
  widthPercent: 80,
  font: { family: "montserrat", weight: 600, size: 18 },
  color: "#FFFFFF",
  stroke: { width: 3, color: "#000000" },
  background: null,
});

/** Una pieza CREATED de 3 slides con una caja por slide: el caso real. */
const created = (over: Partial<Content> = {}): Content => ({
  ...markBuildSucceeded(
    createBuildingContent({
      id: "cnt_1",
      companyId: "co_1",
      type: "slideshow",
      saveBucket: "included",
      textBoxes: [box("slide-0-text-0", 0), box("slide-1-text-0", 1), box("slide-2-text-0", 2)],
      slideCount: 3,
    }),
    { files: ["0.jpg", "1.jpg", "2.jpg"], thumbnailUrl: "t.jpg" },
  ),
  ...over,
});

// ───────────────────────────────────────────────────────────────────────────
// La regla que sostiene la factura
// ───────────────────────────────────────────────────────────────────────────

describe("edición menor — no crea fila, no consume save, no factura (FR-051)", () => {
  it("devuelve la MISMA pieza con revision + 1, no una nueva", () => {
    const before = created();
    const out = applyMinorEdit(
      before,
      0,
      [{ id: "slide-1-text-0", text: "otra copy" }],
      NOW,
    );

    expect(out.content.id).toBe(before.id);
    expect(out.content.revision).toBe(1);
    expect(out.createsNewRow).toBe(false);
    expect(out.consumesSave).toBe(false);
    expect(out.billable).toBe(false);
  });

  it("no toca el ledger: la función ni siquiera recibe uno", () => {
    // La firma es la garantía. Si algún día `applyMinorEdit` necesitara un
    // `SavesLedger`, este test dejaría de compilar y habría que discutirlo.
    expect(applyMinorEdit.length).toBe(4);
  });

  it("conserva los archivos: durante el rebuild la versión previa sigue usable", () => {
    const out = applyMinorEdit(created(), 0, [{ id: "slide-0-text-0", color: "#FF0000" }], NOW);
    expect(out.content.status).toBe("BUILDING");
    expect(out.content.files).toEqual(["0.jpg", "1.jpg", "2.jpg"]);
    expect(out.content.editInProgress).toBe(true);
  });

  it("dos ediciones seguidas llevan la revision a 2, con un solo id", () => {
    const first = applyMinorEdit(created(), 0, [{ id: "slide-0-text-0", text: "a" }], NOW);
    const ready = markEditRebuildSucceeded(first.content, ["0.jpg"], undefined, NOW);
    const second = applyMinorEdit(ready, 1, [{ id: "slide-0-text-0", text: "b" }], NOW);
    expect(second.content.revision).toBe(2);
    expect(second.content.id).toBe("cnt_1");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Concurrencia optimista
// ───────────────────────────────────────────────────────────────────────────

describe("concurrencia optimista por revision (FR-051, criterio 3)", () => {
  it("una revision vieja devuelve stale_revision", () => {
    const c = { ...created(), revision: 3 };
    try {
      assertRevisionMatches(c, 2);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      const err = e as DomainError;
      expect(err.code).toBe("conflict");
      expect(err.details?.code).toBe(CONTENT_ERROR_CODES.staleRevision);
      expect(err.details?.expected).toBe(2);
      expect(err.details?.actual).toBe(3);
    }
  });

  it("stale_revision gana a cualquier otra guarda: el cliente tiene que recargar", () => {
    // Pieza con posts vinculados Y revision desactualizada. El error útil es
    // el que manda a recargar: después de recargar quizá el post ya no está.
    const c = created({ revision: 5, linkedPostCount: 2 });
    try {
      applyMinorEdit(c, 1, [{ id: "slide-0-text-0", text: "x" }], NOW);
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).details?.code).toBe(CONTENT_ERROR_CODES.staleRevision);
    }
  });

  it("la revision correcta pasa", () => {
    expect(() => assertRevisionMatches(created(), 0)).not.toThrow();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Guardas de edición
// ───────────────────────────────────────────────────────────────────────────

describe("cuándo NO se puede editar (FR-051, edge cases)", () => {
  it("BUILDING → unsupported_content_state", () => {
    const c = created({ status: "BUILDING" });
    expect(() => assertContentEditable(c)).toThrow(DomainError);
    try {
      assertContentEditable(c);
    } catch (e) {
      expect((e as DomainError).details?.code).toBe(
        CONTENT_ERROR_CODES.unsupportedState,
      );
    }
  });

  it("FAILED → unsupported_content_state", () => {
    try {
      assertContentEditable(created({ status: "FAILED" }));
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).details?.code).toBe(
        CONTENT_ERROR_CODES.unsupportedState,
      );
    }
  });

  it("ya hay una edición corriendo → content_edit_in_progress", () => {
    try {
      assertContentEditable(created({ editInProgress: true }));
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).details?.code).toBe(CONTENT_ERROR_CODES.editInProgress);
    }
  });

  it("con posts vinculados → content_has_linked_posts (cancelar no basta)", () => {
    try {
      assertContentEditable(created({ linkedPostCount: 1 }));
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      const err = e as DomainError;
      expect(err.details?.code).toBe(CONTENT_ERROR_CODES.hasLinkedPosts);
      expect(err.message).toContain("Delete the posts");
    }
  });

  it("una pieza de payload explícito no es editable en el Studio", () => {
    try {
      assertContentEditable(created({ editable: false }));
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).details?.code).toBe(CONTENT_ERROR_CODES.notEditable);
    }
  });

  it("lo permanente gana a lo transitorio: 'no editable' antes que 'en curso'", () => {
    // Si el orden se invirtiera, al usuario se le pediría esperar a que
    // termine una edición para poder hacer algo que nunca va a poder hacer.
    try {
      assertContentEditable(created({ editable: false, editInProgress: true }));
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).details?.code).toBe(CONTENT_ERROR_CODES.notEditable);
    }
  });

  it("una pieza borrada es not_found, no un estado inválido", () => {
    try {
      assertContentEditable(created({ deletedAt: NOW }));
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect((e as DomainError).code).toBe("not_found");
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// "sin aplicar ningún cambio"
// ───────────────────────────────────────────────────────────────────────────

describe("una edición inválida no aplica NADA (FR-051, Validation)", () => {
  it("la séptima caja inválida no deja las seis primeras movidas", () => {
    const before = created();
    const patches = [
      { id: "slide-0-text-0", text: "nueva 0" },
      { id: "slide-1-text-0", text: "nueva 1" },
      { id: "slide-2-text-0", widthPercent: 10 }, // fuera de [25, 100]
    ];
    expect(() => applyMinorEdit(before, 0, patches, NOW)).toThrow(DomainError);
    // `before` es inmutable y sigue intacto: el caso de uso lo descarta entero.
    expect(before.textBoxes[0]?.text).toBe("copy slide-0-text-0");
    expect(before.revision).toBe(0);
  });

  it("un id inexistente se rechaza", () => {
    expect(() =>
      applyMinorEdit(created(), 0, [{ id: "slide-9-text-0", text: "x" }], NOW),
    ).toThrow(DomainError);
  });

  it("un id duplicado en el parche se rechaza", () => {
    expect(() =>
      applyMinorEdit(
        created(),
        0,
        [
          { id: "slide-0-text-0", text: "a" },
          { id: "slide-0-text-0", text: "b" },
        ],
        NOW,
      ),
    ).toThrow(DomainError);
  });

  it("un campo desconocido en el parche se rechaza", () => {
    expect(() =>
      applyMinorEdit(
        created(),
        0,
        [{ id: "slide-0-text-0", status: "CREATED" } as never],
        NOW,
      ),
    ).toThrow(DomainError);
  });

  it("un parche vacío se rechaza", () => {
    expect(() => applyMinorEdit(created(), 0, [], NOW)).toThrow(DomainError);
  });
});

describe("mezcla del parche", () => {
  it("background: null borra el fondo; omitirlo lo conserva", () => {
    const withBg = created({
      textBoxes: [
        {
          ...box("slide-0-text-0", 0),
          background: { color: "#FFFFFF", opacity: 1, style: "pill" },
        },
      ],
      slideCount: 1,
    });

    const kept = applyMinorEdit(withBg, 0, [{ id: "slide-0-text-0", text: "x" }], NOW);
    expect(kept.content.textBoxes[0]?.background).toEqual({
      color: "#FFFFFF",
      opacity: 1,
      style: "pill",
    });

    const removed = applyMinorEdit(
      withBg,
      0,
      [{ id: "slide-0-text-0", background: null }],
      NOW,
    );
    expect(removed.content.textBoxes[0]?.background).toBeNull();
  });

  it("las cajas que no se parchean quedan idénticas", () => {
    const out = applyMinorEdit(created(), 0, [{ id: "slide-0-text-0", text: "x" }], NOW);
    expect(out.content.textBoxes[1]).toEqual(box("slide-1-text-0", 1));
    expect(out.content.textBoxes[2]).toEqual(box("slide-2-text-0", 2));
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Regenerate Text — AI-004
// ───────────────────────────────────────────────────────────────────────────

describe("Regenerate Text preserva estructura y número de slides (FR-051, criterio 2)", () => {
  const fullCopy = [
    { boxId: "slide-0-text-0", text: "hook nuevo" },
    { boxId: "slide-1-text-0", text: "cuerpo nuevo" },
    { boxId: "slide-2-text-0", text: "cierre nuevo" },
  ];

  it("reescribe TODAS las cajas y conserva slides, geometría y estilo", () => {
    const before = created();
    const out = applyRegeneratedCopy(before, 0, fullCopy, NOW);

    expect(out.content.slideCount).toBe(3);
    expect(out.content.textBoxes).toHaveLength(3);
    expect(out.content.textBoxes.map((b) => b.text)).toEqual([
      "hook nuevo",
      "cuerpo nuevo",
      "cierre nuevo",
    ]);
    // Nada de estilo ni geometría cambió.
    expect(out.content.textBoxes[0]?.font).toEqual(before.textBoxes[0]?.font);
    expect(out.content.textBoxes[0]?.position).toEqual(before.textBoxes[0]?.position);
    expect(out.content.files).toEqual(before.files);
    expect(out.content.revision).toBe(1);
  });

  it("no consume content save ni factura (AI-004)", () => {
    const out = applyRegeneratedCopy(created(), 0, fullCopy, NOW);
    expect(out.consumesSave).toBe(false);
    expect(out.billable).toBe(false);
  });

  it("devolver MENOS cajas de las que hay es un error, no un recorte", () => {
    // Si se aceptara, el render se queda sin qué poner en dos superficies.
    expect(() =>
      applyRegeneratedCopy(created(), 0, fullCopy.slice(0, 2), NOW),
    ).toThrow(DomainError);
  });

  it("devolver una caja de MÁS es un error, no un añadido", () => {
    expect(() =>
      applyRegeneratedCopy(
        created(),
        0,
        [...fullCopy, { boxId: "slide-3-text-0", text: "de más" }],
        NOW,
      ),
    ).toThrow(DomainError);
  });

  it("devolver la misma caja dos veces es un error", () => {
    expect(() =>
      applyRegeneratedCopy(
        created(),
        0,
        [fullCopy[0]!, fullCopy[1]!, fullCopy[1]!],
        NOW,
      ),
    ).toThrow(DomainError);
  });

  it("copy que se pasa de 5 000 caracteres se rechaza igual que en la edición", () => {
    expect(() =>
      applyRegeneratedCopy(
        created(),
        0,
        [
          { boxId: "slide-0-text-0", text: "a".repeat(5001) },
          fullCopy[1]!,
          fullCopy[2]!,
        ],
        NOW,
      ),
    ).toThrow(DomainError);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Rebuild de una edición
// ───────────────────────────────────────────────────────────────────────────

describe("si el rebuild de una edición falla, la versión previa sigue usable", () => {
  it("vuelve a CREATED con sus archivos viejos y reporta lastEdit fallido", () => {
    const edited = applyMinorEdit(created(), 0, [{ id: "slide-0-text-0", text: "x" }], NOW);
    const out = markEditRebuildFailed(edited.content, "render_timeout", NOW);

    expect(out.status).toBe("CREATED");
    expect(out.files).toEqual(["0.jpg", "1.jpg", "2.jpg"]);
    expect(out.editInProgress).toBe(false);
    expect(out.lastEdit).toEqual({
      at: NOW,
      outcome: "failed",
      kind: "rebuild",
      failureReason: "render_timeout",
    });
  });

  it("NO reembolsa el save: ese se cobró por el build original, que salió bien", () => {
    const edited = applyMinorEdit(created(), 0, [{ id: "slide-0-text-0", text: "x" }], NOW);
    const out = markEditRebuildFailed(edited.content, "render_timeout", NOW);
    expect(out.saveRefundedAt).toBeUndefined();
  });

  it("un rebuild exitoso reemplaza los archivos y libera la edición", () => {
    const edited = applyMinorEdit(created(), 0, [{ id: "slide-0-text-0", text: "x" }], NOW);
    const out = markEditRebuildSucceeded(edited.content, ["n0.jpg"], "nt.jpg", NOW);
    expect(out.status).toBe("CREATED");
    expect(out.files).toEqual(["n0.jpg"]);
    expect(out.thumbnailUrl).toBe("nt.jpg");
    expect(out.editInProgress).toBe(false);
    expect(out.revision).toBe(1);
  });
});
