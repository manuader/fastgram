import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Tooltip } from "./Tooltip";

describe("Tooltip (markup)", () => {
  it("cerrado no deja un aria-describedby apuntando a la nada", () => {
    const html = renderToStaticMarkup(
      <Tooltip content="Calendar">
        <button type="button">icon</button>
      </Tooltip>,
    );
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain('role="tooltip"');
    expect(html).toContain("icon");
  });
});
