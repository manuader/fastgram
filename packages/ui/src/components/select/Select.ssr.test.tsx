import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Select } from "./Select.js";

describe("Select (markup)", () => {
  it("es un select nativo con sus opciones", () => {
    const html = renderToStaticMarkup(
      <Select
        aria-label="Aspect ratio"
        defaultValue="4:5"
        options={[
          { value: "1:1", label: "1:1" },
          { value: "4:5", label: "4:5" },
          { value: "9:16", label: "9:16" },
        ]}
      />,
    );
    expect(html).toContain("<select");
    expect(html.match(/<option/g)).toHaveLength(3);
  });

  it("el placeholder no se puede elegir", () => {
    const html = renderToStaticMarkup(
      <Select aria-label="Platform" placeholder="Select a platform" defaultValue="" />,
    );
    expect(html).toContain('value="" disabled');
  });
});
