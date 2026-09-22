import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Input } from "./Input";

describe("Input (markup)", () => {
  it("invalid no es sólo color: pone aria-invalid", () => {
    const html = renderToStaticMarkup(<Input invalid aria-label="Website" />);
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain("fg-input--invalid");
  });

  it("sin icono no envuelve el campo en nada", () => {
    expect(renderToStaticMarkup(<Input aria-label="Search" />)).toMatch(/^<input/);
  });

  it("con icono lo envuelve y lo marca decorativo", () => {
    const html = renderToStaticMarkup(
      <Input aria-label="Search" leadingIcon={<svg />} />,
    );
    expect(html).toContain("fg-input-wrap");
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("fg-input--with-icon");
  });
});
