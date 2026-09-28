import { reelSpecSchema } from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import { reelFixture } from "./fixture";
import {
  clampTiming,
  formatClock,
  initialReelState,
  isDirty,
  reelEditorReducer,
} from "./state";

describe("reelEditorReducer", () => {
  it("arranca con la primera capa de texto elegida y sin cambios", () => {
    const s = initialReelState(reelFixture());
    expect(s.selectedId).toBe("hook");
    expect(isDirty(s)).toBe(false);
  });

  it("acota los tiempos al reel y al largo mínimo, y el spec sigue validando", () => {
    let s = initialReelState(reelFixture());
    s = reelEditorReducer(s, { type: "timing", id: "hook", start: -3, end: 99 });
    expect(s.spec.layers.find((l) => l.id === "hook")).toMatchObject({
      start: 0,
      end: 10,
    });
    s = reelEditorReducer(s, { type: "timing", id: "hook", start: 5, end: 5.05 });
    expect(s.spec.layers.find((l) => l.id === "hook")).toMatchObject({
      start: 5,
      end: 5.2,
    });
    expect(reelSpecSchema.safeParse(s.spec).success).toBe(true);
    expect(isDirty(s)).toBe(true);
  });

  it("mover conserva el largo y frena en el borde", () => {
    let s = initialReelState(reelFixture());
    s = reelEditorReducer(s, { type: "move", id: "clip", delta: 5 });
    expect(s.spec.layers.find((l) => l.id === "clip")).toMatchObject({
      start: 3,
      end: 10,
    });
  });

  it("descartar vuelve al guardado; commit fija el nuevo", () => {
    let s = initialReelState(reelFixture());
    s = reelEditorReducer(s, {
      type: "update",
      id: "hook",
      patch: (l) => (l.kind === "text" ? { ...l, text: "Nuevo" } : l),
    });
    expect(reelEditorReducer(s, { type: "discard" }).spec).toEqual(reelFixture());
    const committed = reelEditorReducer(s, { type: "commit" });
    expect(isDirty(committed)).toBe(false);
  });

  it("acota y formatea", () => {
    expect(clampTiming(9.95, 12, 10)).toEqual({ start: 9.8, end: 10 });
    expect(formatClock(65.25)).toBe("1:05.3");
  });
});
