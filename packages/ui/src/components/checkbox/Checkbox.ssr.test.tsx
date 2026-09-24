import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Checkbox } from "./Checkbox";

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

  it("sin id también enlaza la descripción (P5-A11Y-001)", () => {
    const html = renderToStaticMarkup(
      <Checkbox label="I checked" description="It isn't on the network" />,
    );
    const ref = html.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(ref).toBeDefined();
    expect(html).toContain(`id="${String(ref)}"`);
  });

  it("sin descripción no inventa un aria-describedby colgado", () => {
    const html = renderToStaticMarkup(<Checkbox id="tiktok" label="TikTok" />);
    expect(html).not.toContain("aria-describedby");
  });
});
