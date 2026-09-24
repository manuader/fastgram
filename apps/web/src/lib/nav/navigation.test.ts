import { describe, expect, it } from "vitest";
import { paletteLinks } from "@/components/command/palette-items";
import { PRIMARY_NAV, SECONDARY_NAV, TOOLS_NAV, visibleNav } from "./navigation";

const ids = (items: readonly { id: string }[]) => items.map((item) => item.id);

describe("orden del circuito personal (PU-UI-001)", () => {
  it("el bloque principal es Home, Blitz, Calendar, Library, Brand, Studio", () => {
    expect(ids(PRIMARY_NAV)).toEqual([
      "home",
      "blitz",
      "calendar",
      "library",
      "brand",
      "content",
    ]);
  });

  it("Settings es la última entrada", () => {
    expect(SECONDARY_NAV.at(-1)?.id).toBe("settings");
  });
});

describe("D-15: lo que el modo personal esconde", () => {
  const all = [...PRIMARY_NAV, ...TOOLS_NAV, ...SECONDARY_NAV];

  it("en personal no hay Warmed Accounts, Refer & Earn, Guide, Feedback ni Discord", () => {
    const visible = ids(visibleNav(all, { isStaff: false, mode: "personal" }));
    for (const hidden of [
      "warmed-accounts",
      "refer-and-earn",
      "guide",
      "feedback",
      "discord",
    ])
      expect(visible).not.toContain(hidden);
    expect(visible).toContain("settings");
  });

  it("mientras el modo no se sabe, tampoco", () => {
    const visible = ids(visibleNav(all, { isStaff: false, mode: null }));
    expect(visible).not.toContain("warmed-accounts");
  });

  it("en standard vuelven: las rutas no se borraron", () => {
    const visible = ids(visibleNav(all, { isStaff: false, mode: "standard" }));
    expect(visible).toContain("warmed-accounts");
    expect(visible).toContain("refer-and-earn");
    expect(visible).toContain("guide");
    expect(visible).toContain("feedback");
  });

  it("Admin sigue siendo sólo para staff", () => {
    expect(ids(visibleNav(all, { isStaff: false, mode: "standard" }))).not.toContain(
      "admin",
    );
    expect(ids(visibleNav(all, { isStaff: true, mode: "standard" }))).toContain("admin");
  });
});

describe("paleta ⌘K", () => {
  it("no ofrece lo que el modo personal esconde, ni enlaces externos", () => {
    const links = paletteLinks({ isStaff: false, mode: "personal" }).map((l) => l.id);
    expect(links).not.toContain("nav:warmed-accounts");
    expect(links).not.toContain("nav:refer-and-earn");
    expect(links).not.toContain("nav:discord");
    expect(links).not.toContain("nav:guide");
    expect(links).not.toContain("nav:feedback");
    expect(links).toContain("nav:settings-brands");
    expect(links).toContain("nav:settings-models");
    // Sprint 7: las secciones del hub de Settings también están en la paleta.
    for (const section of ["strategy", "connections", "integrations", "notifications"])
      expect(links).toContain(`nav:settings-${section}`);
  });

  it("los ids no se repiten (cmdk los usa como value)", () => {
    const links = paletteLinks({ isStaff: true, mode: "standard" }).map((l) => l.id);
    expect(new Set(links).size).toBe(links.length);
  });
});
