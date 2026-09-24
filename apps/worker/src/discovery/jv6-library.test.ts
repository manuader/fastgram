/**
 * `P4-JV-004` (sprint 8, K): con varios modelos de la biblioteca asignados a
 * una marca, `JV-6` los distingue por su perfil. Lo que se fija es qué llega
 * a la pregunta: sin perfil, lo de antes (nombre y género).
 */
import { describe, expect, it } from "vitest";

import { describeInfluencerCandidate, libraryModelProfile } from "./jv6.js";

describe("describeInfluencerCandidate", () => {
  it("sin perfil: nombre y género, como antes del sprint 8", () => {
    expect(describeInfluencerCandidate("Emily", "female", undefined)).toBe(
      "name: Emily; gender: female",
    );
    expect(describeInfluencerCandidate("Emily", null, undefined)).toBe("name: Emily");
  });

  it("con modelo de la biblioteca: suma su perfil", () => {
    expect(describeInfluencerCandidate("Mia", null, "age: 27; style: streetwear")).toBe(
      "name: Mia; age: 27; style: streetwear",
    );
  });
});

describe("libraryModelProfile", () => {
  it("edad, estilo y notas, en ese orden; omite lo vacío", () => {
    expect(libraryModelProfile({ age: 30, style: " skater ", notes: null })).toBe(
      "age: 30; style: skater",
    );
    expect(libraryModelProfile({ age: null, style: "", notes: "  " })).toBe("");
  });

  it("recorta notas largas y colapsa espacios (la pregunta es acotada)", () => {
    const notes = `loves\n\nhiking ${"x".repeat(400)}`;
    const out = libraryModelProfile({ age: null, style: null, notes });
    expect(out.startsWith("notes: loves hiking ")).toBe(true);
    expect(out.length).toBeLessThanOrEqual("notes: ".length + 200);
  });
});
