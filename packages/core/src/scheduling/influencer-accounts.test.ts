import { describe, expect, it } from "vitest";

import { planSlotConversion, type SlotStrategy } from "./auto-slot.js";
import { preferInfluencerAccounts } from "./influencer-accounts.js";

const strategy: SlotStrategy = {
  networks: [
    { network: "instagram", enabled: true, perDay: 1, dailyCap: 3 },
    { network: "tiktok", enabled: true, perDay: 1, dailyCap: 3 },
    { network: "x", enabled: false, perDay: 1, dailyCap: 3 },
  ],
  windows: { sun: [], mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] },
  timezone: "UTC",
  jitterMinutes: 0,
  brandGapMinutes: 0,
};

const active = [
  { id: "ig-1", platform: "instagram" },
  { id: "ig-2", platform: "instagram" },
  { id: "tt-1", platform: "tiktok" },
  { id: "x-1", platform: "x" },
];

describe("preferInfluencerAccounts", () => {
  it("sin cuentas marcadas no hay preferencia", () => {
    for (const accounts of [null, undefined, [], "basura", [{ enabled: false }]]) {
      const out = preferInfluencerAccounts(strategy, active, accounts);
      expect(out.networks).toBeUndefined();
      expect(out.connections).toBe(active);
      expect(out.pinned.size).toBe(0);
    }
  });

  it("con una cuenta marcada: sólo su red, y la conversión usa esa cuenta", () => {
    const out = preferInfluencerAccounts(strategy, active, [
      { platform: "instagram", connectionId: "ig-2", enabled: true },
      { platform: "tiktok", connectionId: "tt-1", enabled: false },
    ]);
    expect(out.networks).toEqual(["instagram"]);
    // Dos conexiones de Instagram serían ambiguas; la marcada lo resuelve.
    expect(planSlotConversion("instagram", active)).toMatchObject({ kind: "wait" });
    expect(planSlotConversion("instagram", out.connections)).toEqual({
      kind: "convert",
      platform: "instagram",
      connectionId: "ig-2",
    });
    // Una red sin marcadas conserva todas sus conexiones.
    expect(out.connections.some((c) => c.id === "tt-1")).toBe(true);
    expect([...out.pinned]).toEqual([["instagram", "ig-2"]]);
  });

  it("dos marcadas en la misma red: las dos candidatas, ninguna fijada", () => {
    const out = preferInfluencerAccounts(strategy, active, [
      { platform: "instagram", connectionId: "ig-1", enabled: true },
      { platform: "instagram", connectionId: "ig-2", enabled: true },
    ]);
    expect(out.networks).toEqual(["instagram"]);
    expect(out.pinned.size).toBe(0);
  });

  it("una cuenta marcada que ya no está activa, o de otra red, no cuenta", () => {
    const out = preferInfluencerAccounts(strategy, active, [
      { platform: "instagram", connectionId: "desconectada", enabled: true },
      { platform: "tiktok", connectionId: "ig-1", enabled: true },
    ]);
    expect(out.networks).toBeUndefined();
    expect(out.connections).toBe(active);
  });

  it("marcadas sólo en redes sin cupo en la estrategia: no restringe las redes", () => {
    const out = preferInfluencerAccounts(strategy, active, [
      { platform: "x", connectionId: "x-1", enabled: true },
    ]);
    expect(out.networks).toBeUndefined();
    expect(out.connections.map((c) => c.id)).toEqual(["ig-1", "ig-2", "tt-1", "x-1"]);
  });
});
