import { describe, expect, it } from "vitest";
import { getInitials } from "./initials.js";

describe("getInitials", () => {
  it("toma la primera y la última palabra", () => {
    expect(getInitials("Ada Lovelace")).toBe("AL");
    expect(getInitials("Jean Baptiste Emmanuel Zorg")).toBe("JZ");
  });

  it("con una sola palabra devuelve una letra", () => {
    expect(getInitials("Blitz")).toBe("B");
  });

  it("normaliza espacios y devuelve vacío si no hay nombre", () => {
    expect(getInitials("   ")).toBe("");
    expect(getInitials("")).toBe("");
    expect(getInitials("  ada   lovelace  ")).toBe("AL");
  });

  it("no parte un grafema por la mitad", () => {
    // Con charAt(0) esto devolvería medio par suplente y se vería como "".
    expect(getInitials("😀 Bot")).toBe("😀B");
  });

  it("respeta el máximo", () => {
    expect(getInitials("Ada Lovelace", 1)).toBe("A");
  });
});
