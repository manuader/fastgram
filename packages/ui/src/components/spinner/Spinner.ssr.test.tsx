import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Spinner } from "./Spinner.js";

describe("Spinner (markup)", () => {
  it("se anuncia como status con el copy `Loading...` del PRD", () => {
    const html = renderToStaticMarkup(<Spinner />);
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading...");
    expect(html).toContain("fg-visually-hidden");
  });

  it("acepta un label propio", () => {
    expect(renderToStaticMarkup(<Spinner label="Preparing video" />)).toContain(
      "Preparing video",
    );
  });

  it("con aria-hidden es decorativo y no anuncia nada", () => {
    const html = renderToStaticMarkup(<Spinner aria-hidden />);
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain("Loading...");
  });
});
