import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button } from "./Button.js";

describe("Button (markup)", () => {
  it("es type=button salvo que se pida otra cosa", () => {
    expect(renderToStaticMarkup(<Button>Save</Button>)).toContain('type="button"');
    expect(renderToStaticMarkup(<Button type="submit">Save</Button>)).toContain(
      'type="submit"',
    );
  });

  it("loading deshabilita y marca aria-busy", () => {
    const html = renderToStaticMarkup(<Button loading>Save</Button>);
    expect(html).toContain("disabled");
    expect(html).toContain('aria-busy="true"');
    // El label sigue ahí: el botón no cambia de ancho al pulsarlo.
    expect(html).toContain("Save");
  });

  it("los iconos son decorativos para el lector de pantalla", () => {
    const html = renderToStaticMarkup(
      <Button leadingIcon={<svg />} trailingIcon={<svg />}>
        Remix
      </Button>,
    );
    expect(html.match(/aria-hidden="true"/g)).toHaveLength(2);
  });

  it("deja pasar aria-label para el botón sólo-icono", () => {
    const html = renderToStaticMarkup(
      <Button size="icon" aria-label="Close" leadingIcon={<svg />} />,
    );
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain("fg-btn--icon");
  });
});
