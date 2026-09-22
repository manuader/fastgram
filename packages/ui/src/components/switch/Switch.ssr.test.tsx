import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Switch } from "./Switch";

describe("Switch (markup)", () => {
  it("expone role=switch con su estado", () => {
    expect(renderToStaticMarkup(<Switch aria-label="Auto-Add Music" />)).toContain(
      'aria-checked="false"',
    );
    expect(
      renderToStaticMarkup(<Switch aria-label="Auto-Add Music" checked />),
    ).toContain('aria-checked="true"');
  });

  it("es un button, así que Enter y Espacio ya funcionan", () => {
    const html = renderToStaticMarkup(<Switch aria-label="Mention business" />);
    expect(html).toContain('type="button"');
    expect(html).toContain('role="switch"');
  });

  it("el estado inicial no controlado sale de defaultChecked", () => {
    expect(renderToStaticMarkup(<Switch aria-label="x" defaultChecked />)).toContain(
      'aria-checked="true"',
    );
  });
});
