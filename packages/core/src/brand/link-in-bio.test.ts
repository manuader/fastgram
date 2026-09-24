import { describe, expect, it } from "vitest";

import { linkDestinationItem, linkInBioTargets } from "./synthesis.js";

describe("link-in-bio · INT-018 / P1-BRAND-015", () => {
  it("sólo http(s), sin credenciales, sin la propia fuente, máx. 5 y sin repetir", () => {
    const out = linkInBioTargets(
      [
        "https://acme.com/shop",
        "javascript:alert(1)",
        "mailto:hi@acme.com",
        "https://user:pw@acme.com/",
        "https://instagram.com/acme/",
        "https://ACME.com/shop",
        "https://a.com",
        "https://b.com",
        "https://c.com",
        "https://d.com",
        "https://e.com",
      ],
      "https://instagram.com/acme",
    );
    expect(out).toEqual([
      "https://acme.com/shop",
      "https://a.com",
      "https://b.com",
      "https://c.com",
      "https://d.com",
    ]);
  });
  it("sin links, nada", () => {
    expect(linkInBioTargets(undefined)).toEqual([]);
  });
  it("un destino sin texto no aporta ítem", () => {
    expect(linkDestinationItem("https://a.com", {})).toBeNull();
    expect(
      linkDestinationItem("https://a.com", { displayName: "Shop", bio: "Mugs" }),
    ).toMatchObject({
      kind: "text",
      title: "Shop",
      caption: "Mugs",
      permalink: "https://a.com",
    });
  });
});
