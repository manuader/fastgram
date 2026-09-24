import { describe, expect, it } from "vitest";
import { canSaveSet, setProgress } from "./sets";
import { parseTagInput } from "./tags";

describe("CREATING SET · PRD:1651", () => {
  it("`0 selected (need 5 more)`", () => {
    expect(setProgress(0)).toEqual({ selected: 0, missing: 5, enough: false });
    expect(setProgress(4).missing).toBe(1);
    expect(setProgress(7)).toEqual({ selected: 7, missing: 0, enough: true });
  });

  it("Save pide nombre y el mínimo", () => {
    expect(canSaveSet("Bedroom shots", 4)).toBe(false);
    expect(canSaveSet("   ", 5)).toBe(false);
    expect(canSaveSet("Bedroom shots", 5)).toBe(true);
  });
});

describe("etiquetas", () => {
  it("minúsculas, sin repetir, sin vacías", () => {
    expect(parseTagInput("Cats, cats , dog,, ")).toEqual(["cats", "dog"]);
  });
});
