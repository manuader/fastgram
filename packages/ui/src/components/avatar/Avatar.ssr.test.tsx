import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Avatar } from "./Avatar.js";

describe("Avatar (markup)", () => {
  it("con src renderiza la imagen", () => {
    const html = renderToStaticMarkup(
      <Avatar src="https://example.test/a.png" alt="Mia" />,
    );
    expect(html).toContain("<img");
    expect(html).toContain('alt="Mia"');
  });

  it("sin src cae a las iniciales, ocultas si el avatar es decorativo", () => {
    const html = renderToStaticMarkup(<Avatar name="Mia Carter" />);
    expect(html).toContain("MC");
    expect(html).toContain('aria-hidden="true"');
  });

  it("con alt las iniciales dejan de estar ocultas", () => {
    const html = renderToStaticMarkup(<Avatar name="Mia Carter" alt="Mia Carter" />);
    expect(html).not.toContain("aria-hidden");
  });
});
