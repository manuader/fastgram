import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Sin @testing-library no se puede montar el componente. Lo que sí se puede
// fijar es el contrato de accesibilidad que su CSS sostiene: si alguien cambia
// el input invisible por display:none, el checkbox deja de ser tabulable y
// ningún test de variantes lo notaría.
const css = readFileSync(fileURLToPath(new URL("./checkbox.css", import.meta.url)), "utf8");

describe("checkbox.css", () => {
  it("oculta el input con opacidad, no sacándolo del orden de tabulación", () => {
    const block = css.slice(css.indexOf(".fg-checkbox__input {"));
    const declarations = block.slice(0, block.indexOf("}"));
    expect(declarations).toContain("opacity: 0");
    expect(declarations).not.toContain("display: none");
    expect(declarations).not.toContain("visibility: hidden");
  });

  it("pinta la marca desde el estado nativo :checked y :indeterminate", () => {
    expect(css).toContain(".fg-checkbox__input:checked + .fg-checkbox__box");
    expect(css).toContain(".fg-checkbox__input:indeterminate + .fg-checkbox__box");
  });
});
