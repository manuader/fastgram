import { describe, expect, it } from "vitest";

import {
  ANTI_BOT_DAILY_CAP_DEFAULT,
  AUTO_SLOT_MIN_LEAD_MS,
  findNextSlot,
  jitterOffsetMs,
  planAutoSlots,
  planSlotConversion,
  type NetworkPlan,
  type OccupiedSlot,
  type SlotStrategy,
  type WeekdayKey,
} from "./auto-slot.js";
import { civilDateOf, timeZoneOffsetMs, zonedWallTimeToUtc } from "./zoned-time.js";

const MIN = 60_000;
const BA = "America/Argentina/Buenos_Aires"; // UTC−3, sin horario de verano
const NY = "America/New_York";

const everyDay = (times: readonly string[]): Record<WeekdayKey, readonly string[]> => ({
  sun: times,
  mon: times,
  tue: times,
  wed: times,
  thu: times,
  fri: times,
  sat: times,
});

function strategy(over: Partial<SlotStrategy> = {}): SlotStrategy {
  const ig: NetworkPlan = { network: "instagram", enabled: true, perDay: 1, dailyCap: 3 };
  return {
    networks: [ig],
    windows: everyDay(["09:00", "18:00"]),
    timezone: BA,
    jitterMinutes: 0,
    brandGapMinutes: 10,
    ...over,
  };
}

/** Martes 22-sep-2026, 08:00 en Buenos Aires (11:00Z). */
const NOW = Date.UTC(2026, 8, 22, 11, 0);
/** 09:00 BA de ese día = 12:00Z. */
const TUE_9 = Date.UTC(2026, 8, 22, 12, 0);

describe("zonedWallTimeToUtc", () => {
  it("convierte una hora local de una zona sin DST", () => {
    expect(zonedWallTimeToUtc({ year: 2026, month: 9, day: 22 }, 9 * 60, BA)).toBe(TUE_9);
  });

  it("en el adelanto de NY (8-mar-2026) las 02:30 no existen: se corren a las 03:30 EDT", () => {
    const at = zonedWallTimeToUtc({ year: 2026, month: 3, day: 8 }, 2 * 60 + 30, NY);
    // 03:30 EDT = 07:30Z
    expect(at).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });

  it("el mismo día, una ventana después del salto usa el offset nuevo (−4)", () => {
    const at = zonedWallTimeToUtc({ year: 2026, month: 3, day: 8 }, 9 * 60, NY);
    expect(at).toBe(Date.UTC(2026, 2, 8, 13, 0));
    // y el día anterior, el viejo (−5)
    const before = zonedWallTimeToUtc({ year: 2026, month: 3, day: 7 }, 9 * 60, NY);
    expect(before).toBe(Date.UTC(2026, 2, 7, 14, 0));
  });

  it("en el atraso de NY (1-nov-2026) las 01:30 existen dos veces: gana la primera", () => {
    const at = zonedWallTimeToUtc({ year: 2026, month: 11, day: 1 }, 90, NY);
    expect(at).toBe(Date.UTC(2026, 10, 1, 5, 30)); // 01:30 EDT
  });

  it("también gana la primera en una zona con offset positivo (Madrid, 25-oct-2026)", () => {
    const at = zonedWallTimeToUtc(
      { year: 2026, month: 10, day: 25 },
      2 * 60 + 30,
      "Europe/Madrid",
    );
    expect(at).toBe(Date.UTC(2026, 9, 25, 0, 30)); // 02:30 CEST (+2)
  });

  it("el offset que usa es el de la zona en ese instante", () => {
    expect(timeZoneOffsetMs(Date.UTC(2026, 0, 15), NY)).toBe(-5 * 60 * MIN);
    expect(timeZoneOffsetMs(Date.UTC(2026, 6, 15), NY)).toBe(-4 * 60 * MIN);
  });
});

describe("findNextSlot", () => {
  it("elige la primera ventana libre de hoy", () => {
    const slot = findNextSlot({
      strategy: strategy(),
      brandId: "a",
      network: "instagram",
      contentId: "c1",
      nowMs: NOW,
      occupied: [],
    });
    expect(slot?.atMs).toBe(TUE_9);
    expect(slot?.localDay).toBe("2026-09-22");
  });

  it("con el cupo del día lleno pasa al día siguiente", () => {
    const occupied: OccupiedSlot[] = [
      { brandId: "a", network: "instagram", atMs: TUE_9 },
    ];
    const slot = findNextSlot({
      strategy: strategy(), // perDay 1
      brandId: "a",
      network: "instagram",
      contentId: "c1",
      nowMs: NOW,
      occupied,
    });
    // Queda la ventana de las 18:00 de hoy, pero el cupo (1) ya se usó.
    expect(slot?.localDay).toBe("2026-09-23");
    expect(slot?.atMs).toBe(TUE_9 + 24 * 60 * MIN);
  });

  it("con cupo, la ventana tomada se saltea y va a la siguiente del mismo día", () => {
    const s = strategy({
      networks: [{ network: "instagram", enabled: true, perDay: 2, dailyCap: 3 }],
    });
    const slot = findNextSlot({
      strategy: s,
      brandId: "a",
      network: "instagram",
      contentId: "c1",
      nowMs: NOW,
      occupied: [{ brandId: "a", network: "instagram", atMs: TUE_9 }],
    });
    expect(slot?.atMs).toBe(Date.UTC(2026, 8, 22, 21, 0)); // 18:00 BA
  });

  it("el tope anti-bot manda sobre perDay", () => {
    const s = strategy({
      networks: [{ network: "instagram", enabled: true, perDay: 5, dailyCap: 1 }],
    });
    const slot = findNextSlot({
      strategy: s,
      brandId: "a",
      network: "instagram",
      contentId: "c1",
      nowMs: NOW,
      occupied: [{ brandId: "a", network: "instagram", atMs: TUE_9 }],
    });
    expect(slot?.localDay).toBe("2026-09-23");
    expect(ANTI_BOT_DAILY_CAP_DEFAULT).toBe(3);
  });

  it("respeta las ventanas por día de la semana", () => {
    // Sólo los jueves a las 10:00.
    const s = strategy({
      windows: { ...everyDay([]), thu: ["10:00"] },
    });
    const slot = findNextSlot({
      strategy: s,
      brandId: "a",
      network: "instagram",
      contentId: "c1",
      nowMs: NOW,
      occupied: [],
    });
    expect(slot?.localDay).toBe("2026-09-24"); // jueves
    expect(slot?.atMs).toBe(Date.UTC(2026, 8, 24, 13, 0));
  });

  it("una ventana que ya pasó (o empieza antes del margen) no sirve", () => {
    const slot = findNextSlot({
      strategy: strategy(),
      brandId: "a",
      network: "instagram",
      contentId: "c1",
      nowMs: TUE_9 - AUTO_SLOT_MIN_LEAD_MS + 1,
      occupied: [],
    });
    expect(slot?.atMs).toBe(Date.UTC(2026, 8, 22, 21, 0));
  });

  it("aplica el jitter determinista y dentro de ±7 min", () => {
    const s = strategy({ jitterMinutes: 7 });
    const run = (contentId: string) =>
      findNextSlot({
        strategy: s,
        brandId: "a",
        network: "instagram",
        contentId,
        nowMs: NOW,
        occupied: [],
      });
    const first = run("contenido-1");
    const again = run("contenido-1");
    expect(first?.atMs).toBe(again?.atMs);
    expect(first?.windowMs).toBe(TUE_9);
    expect(Math.abs((first?.atMs ?? 0) - TUE_9)).toBeLessThanOrEqual(7 * MIN);

    const offsets = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const offset = jitterOffsetMs(`c-${String(i)}`, 7);
      expect(Math.abs(offset)).toBeLessThanOrEqual(7 * MIN);
      offsets.add(offset);
    }
    // Reparte: no es una constante disfrazada.
    expect(offsets.size).toBeGreaterThan(150);
    expect(jitterOffsetMs("x", 0)).toBe(0);
  });

  it("separa de otra marca del mismo dueño corriendo la hora hacia adelante", () => {
    const occupied: OccupiedSlot[] = [
      { brandId: "b", network: "tiktok", atMs: TUE_9 + 3 * MIN },
    ];
    const slot = findNextSlot({
      strategy: strategy(),
      brandId: "a",
      network: "instagram",
      contentId: "c1",
      nowMs: NOW,
      occupied,
    });
    expect(slot?.atMs).toBe(TUE_9 + 13 * MIN);
    expect(slot?.windowMs).toBe(TUE_9);
  });

  it("encadena separaciones con varias marcas", () => {
    const occupied: OccupiedSlot[] = [
      { brandId: "b", network: "tiktok", atMs: TUE_9 },
      { brandId: "c", network: "x", atMs: TUE_9 + 12 * MIN },
    ];
    const slot = findNextSlot({
      strategy: strategy(),
      brandId: "a",
      network: "instagram",
      contentId: "c1",
      nowMs: NOW,
      occupied,
    });
    expect(slot?.atMs).toBe(TUE_9 + 22 * MIN);
  });

  it("si la separación la aleja demasiado de la ventana, usa la ventana siguiente", () => {
    // Otra marca ocupa 09:00…09:50 cada 10 min: correr la de "a" la llevaría a
    // las 10:00, más de 30 min fuera de su ventana.
    const occupied: OccupiedSlot[] = [0, 10, 20, 30, 40, 50].map((m) => ({
      brandId: "b",
      network: "tiktok",
      atMs: TUE_9 + m * MIN,
    }));
    const slot = findNextSlot({
      strategy: strategy(),
      brandId: "a",
      network: "instagram",
      contentId: "c1",
      nowMs: NOW,
      occupied,
    });
    expect(slot?.windowMs).toBe(Date.UTC(2026, 8, 22, 21, 0));
  });

  it("la misma marca en otra red no pide separación", () => {
    const slot = findNextSlot({
      strategy: strategy(),
      brandId: "a",
      network: "instagram",
      contentId: "c1",
      nowMs: NOW,
      occupied: [{ brandId: "a", network: "tiktok", atMs: TUE_9 }],
    });
    expect(slot?.atMs).toBe(TUE_9);
  });

  it("cuenta el cupo por día **local** de la marca, no por día UTC", () => {
    // 22:00 BA del martes = 01:00Z del miércoles. Cuenta para el martes.
    const lateTuesday = Date.UTC(2026, 8, 23, 1, 0);
    expect(civilDateOf(lateTuesday, BA).day).toBe(22);
    const slot = findNextSlot({
      strategy: strategy(),
      brandId: "a",
      network: "instagram",
      contentId: "c1",
      nowMs: NOW,
      occupied: [{ brandId: "a", network: "instagram", atMs: lateTuesday }],
    });
    expect(slot?.localDay).toBe("2026-09-23");
  });

  it("en una zona con DST, la ventana de las 09:00 sigue siendo las 09:00 locales tras el cambio", () => {
    const s = strategy({ timezone: NY, windows: everyDay(["09:00"]) });
    // Sábado 7-mar-2026 10:00 EST: la de hoy ya pasó, la próxima es el domingo del cambio.
    const now = Date.UTC(2026, 2, 7, 15, 0);
    const slot = findNextSlot({
      strategy: s,
      brandId: "a",
      network: "instagram",
      contentId: "c1",
      nowMs: now,
      occupied: [],
    });
    expect(slot?.localDay).toBe("2026-03-08");
    expect(slot?.atMs).toBe(Date.UTC(2026, 2, 8, 13, 0)); // 09:00 EDT
  });

  it("una red apagada, con cupo 0 o sin ventanas no devuelve nada", () => {
    const off = strategy({
      networks: [{ network: "instagram", enabled: false, perDay: 1, dailyCap: 3 }],
    });
    const zero = strategy({
      networks: [{ network: "instagram", enabled: true, perDay: 0, dailyCap: 3 }],
    });
    const empty = strategy({ windows: everyDay([]) });
    for (const s of [off, zero, empty]) {
      expect(
        findNextSlot({
          strategy: s,
          brandId: "a",
          network: "instagram",
          contentId: "c1",
          nowMs: NOW,
          occupied: [],
        }),
      ).toBeNull();
    }
  });
});

describe("planAutoSlots", () => {
  const two = strategy({
    networks: [
      { network: "instagram", enabled: true, perDay: 1, dailyCap: 3 },
      { network: "tiktok", enabled: true, perDay: 1, dailyCap: 3 },
      { network: "x", enabled: false, perDay: 1, dailyCap: 3 },
    ],
  });

  it("un horario por red activa", () => {
    const out = planAutoSlots({
      strategy: two,
      brandId: "a",
      contentId: "c1",
      nowMs: NOW,
      occupied: [],
    });
    expect(out.map((o) => (o.kind === "slot" ? o.slot.network : o.network))).toEqual([
      "instagram",
      "tiktok",
    ]);
  });

  it("no reprograma una red que ya tiene esta pieza", () => {
    const out = planAutoSlots({
      strategy: two,
      brandId: "a",
      contentId: "c1",
      nowMs: NOW,
      occupied: [],
      alreadyScheduled: ["tiktok"],
    });
    expect(out[1]).toEqual({
      kind: "skipped",
      network: "tiktok",
      reason: "already_scheduled",
    });
  });

  it("filtra por las redes pedidas", () => {
    const out = planAutoSlots({
      strategy: two,
      brandId: "a",
      contentId: "c1",
      nowMs: NOW,
      occupied: [],
      networks: ["tiktok"],
    });
    expect(out).toHaveLength(1);
  });

  it("sin lugar en el horizonte: no_free_slot", () => {
    const out = planAutoSlots({
      strategy: two,
      brandId: "a",
      contentId: "c1",
      nowMs: NOW,
      occupied: [],
      horizonDays: 0,
    });
    expect(out.every((o) => o.kind === "skipped" && o.reason === "no_free_slot")).toBe(
      true,
    );
  });
});

describe("planSlotConversion", () => {
  it("con exactamente una conexión activa en la red, convierte", () => {
    expect(
      planSlotConversion("instagram", [
        { id: "k1", platform: "instagram" },
        { id: "k2", platform: "tiktok" },
      ]),
    ).toEqual({ kind: "convert", platform: "instagram", connectionId: "k1" });
  });

  it("sin conexión, o con varias, espera", () => {
    expect(planSlotConversion("tiktok", [])).toEqual({
      kind: "wait",
      reason: "no_connection",
    });
    expect(
      planSlotConversion("tiktok", [
        { id: "k1", platform: "tiktok" },
        { id: "k2", platform: "tiktok" },
      ]),
    ).toEqual({ kind: "wait", reason: "connection_ambiguous" });
  });

  it("X, Threads y Facebook (D-09) convierten con una conexión activa única", () => {
    for (const network of ["x", "threads", "facebook"] as const) {
      expect(
        planSlotConversion(network, [
          { id: `k-${network}`, platform: network },
          { id: "k-ig", platform: "instagram" },
        ]),
      ).toEqual({ kind: "convert", platform: network, connectionId: `k-${network}` });
    }
  });

  it("X, Threads y Facebook sin conexión o con varias, esperan", () => {
    for (const network of ["x", "threads", "facebook"] as const) {
      expect(planSlotConversion(network, [])).toEqual({
        kind: "wait",
        reason: "no_connection",
      });
      expect(
        planSlotConversion(network, [
          { id: "a", platform: network },
          { id: "b", platform: network },
        ]),
      ).toEqual({ kind: "wait", reason: "connection_ambiguous" });
    }
  });

  it("LinkedIn sigue siendo sólo slot planificado", () => {
    expect(planSlotConversion("linkedin", [{ id: "k", platform: "linkedin" }])).toEqual({
      kind: "wait",
      reason: "network_not_postable",
    });
  });
});
