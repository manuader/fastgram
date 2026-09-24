import { describe, expect, it } from "vitest";
import { isPaletteShortcut } from "./use-palette-hotkey";

const key = (over: Partial<Parameters<typeof isPaletteShortcut>[0]>) => ({
  key: "k",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...over,
});

describe("isPaletteShortcut", () => {
  it("⌘K y Ctrl+K abren la paleta (también con Caps Lock)", () => {
    expect(isPaletteShortcut(key({ metaKey: true }))).toBe(true);
    expect(isPaletteShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(key({ ctrlKey: true, key: "K" }))).toBe(true);
  });

  it("una k a secas, o con Shift/Alt, no", () => {
    expect(isPaletteShortcut(key({}))).toBe(false);
    expect(isPaletteShortcut(key({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isPaletteShortcut(key({ ctrlKey: true, altKey: true }))).toBe(false);
  });
});
