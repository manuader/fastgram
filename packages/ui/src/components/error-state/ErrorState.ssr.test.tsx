import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ErrorState } from "./ErrorState";

const noop = (): void => {};

describe("ErrorState (markup)", () => {
  it("por defecto es el error genérico del PRD §19.3, anunciado como alert", () => {
    const html = renderToStaticMarkup(<ErrorState />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("Something went wrong");
  });

  it("onRetry renderiza el botón con el copy `Try again`", () => {
    const html = renderToStaticMarkup(<ErrorState onRetry={noop} />);
    expect(html).toContain("Try again");
    expect(html).toContain("<button");
  });

  it("sin acción no dibuja una zona de acciones vacía", () => {
    expect(renderToStaticMarkup(<ErrorState />)).not.toContain("fg-state__actions");
  });

  it("ERR-U02 trae título y descripción literales", () => {
    const html = renderToStaticMarkup(<ErrorState preset="ERR-U02" />);
    expect(html).toContain("Lead Not Found");
    expect(html).toContain("This lead may have been deleted or is no longer available.");
  });

  it("se le puede bajar el rol cuando el error es secundario", () => {
    expect(renderToStaticMarkup(<ErrorState role="status" />)).toContain('role="status"');
  });
});
