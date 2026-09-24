import { describe, expect, it } from "vitest";

import { GREEN_SCREEN_MIN_SECONDS, greenScreenLoopArgs } from "./formats.js";

describe("green screen: el meme corto se repite hasta el mínimo", () => {
  it("2,27 s → se repite 2 veces más (6,8 s ≥ 5 s)", () => {
    expect(greenScreenLoopArgs(2.27)).toEqual(["-stream_loop", "2"]);
  });

  it("largo suficiente o duración desconocida → sin loop", () => {
    expect(greenScreenLoopArgs(GREEN_SCREEN_MIN_SECONDS)).toEqual([]);
    expect(greenScreenLoopArgs(8)).toEqual([]);
    expect(greenScreenLoopArgs(null)).toEqual([]);
    expect(greenScreenLoopArgs(0)).toEqual([]);
  });
});
