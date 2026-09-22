import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Pagination } from "./Pagination";

const noop = (): void => {};

describe("Pagination (markup)", () => {
  it("es un nav con nombre y muestra `Page X of Y`", () => {
    const html = renderToStaticMarkup(
      <Pagination page={3} totalPages={72} onPageChange={noop} />,
    );
    expect(html).toContain("<nav");
    expect(html).toContain('aria-label="Pagination"');
    expect(html).toContain("Page 3 of 72");
  });

  it("apaga la flecha que no lleva a ningún lado", () => {
    const first = renderToStaticMarkup(
      <Pagination page={1} totalPages={5} onPageChange={noop} />,
    );
    const last = renderToStaticMarkup(
      <Pagination page={5} totalPages={5} onPageChange={noop} />,
    );
    expect(first.match(/disabled/g)).toHaveLength(1);
    expect(last.match(/disabled/g)).toHaveLength(1);
  });

  it("en modo numbers marca la página actual con aria-current", () => {
    const html = renderToStaticMarkup(
      <Pagination page={3} totalPages={72} display="numbers" onPageChange={noop} />,
    );
    expect(html).toContain('aria-current="page"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Go to page 3"');
    // La elipsis es decorativa: no es un destino al que se pueda ir.
    expect(html).toContain('aria-hidden="true"');
  });
});
