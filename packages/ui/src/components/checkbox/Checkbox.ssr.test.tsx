import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Checkbox } from "./Checkbox.js";

describe("Checkbox (markup)", () => {
  it("es un input nativo dentro de un label, no un div con rol", () => {
    const html = renderToStaticMarkup(<Checkbox label="Post Directly" />);
    expect(html).toContain("<label");
    expect(html).toContain('type="checkbox"');
    expect(html).not.toContain('role="checkbox"');
  });

  it("enlaza la descripción con aria-describedby cuando hay id", () => {
    const html = renderToStaticMarkup(
      <Checkbox id="tiktok" label="TikTok" description="Send to Inbox" />,
    );
    expect(html).toContain('aria-describedby="tiktok-description"');
    expect(html).toContain('id="tiktok-description"');
  });

  it("sin descripción no inventa un aria-describedby colgado", () => {
    const html = renderToStaticMarkup(<Checkbox id="tiktok" label="TikTok" />);
    expect(html).not.toContain("aria-describedby");
  });
});
