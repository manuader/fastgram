/**
 * La aritmética del tablero. Los casos de DST son **los mismos** que los de
 * `packages/core/src/scheduling/auto-slot.test.ts`: `wallTimeToUtc` es una
 * copia de `zonedWallTimeToUtc` y, si divergen, el calendario dibuja a una hora
 * distinta de la que el auto-slot programó.
 */
import type { CalendarItem } from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import {
  dayOfDropId,
  dropIdOf,
  itemsByDay,
  monthRange,
  movedInstant,
  queryRange,
  resolveDrop,
  wallTimeToUtc,
  weekStartOf,
} from "./board";

const BA = "America/Argentina/Buenos_Aires";
const NY = "America/New_York";

function item(over: Partial<CalendarItem> = {}): CalendarItem {
  return {
    kind: "post",
    id: "00000000-0000-4000-8000-000000000001",
    brandId: "00000000-0000-4000-8000-00000000000a",
    brandName: "Acme",
    contentId: "c" as CalendarItem["contentId"],
    network: "tiktok",
    status: "SCHEDULED",
    at: Date.UTC(2026, 8, 23, 12, 7),
    movable: true,
    ...over,
  };
}

describe("wallTimeToUtc (paridad con core)", () => {
  it("sin DST", () => {
    expect(wallTimeToUtc("2026-09-22", 9 * 60, BA)).toBe(Date.UTC(2026, 8, 22, 12, 0));
  });
  it("la hora que no existe se corre hacia adelante", () => {
    expect(wallTimeToUtc("2026-03-08", 150, NY)).toBe(Date.UTC(2026, 2, 8, 7, 30));
  });
  it("la que existe dos veces es la primera", () => {
    expect(wallTimeToUtc("2026-11-01", 90, NY)).toBe(Date.UTC(2026, 10, 1, 5, 30));
    expect(wallTimeToUtc("2026-10-25", 150, "Europe/Madrid")).toBe(
      Date.UTC(2026, 9, 25, 0, 30),
    );
  });
});

describe("mover", () => {
  it("conserva la hora local aunque cambie el offset (NY, sábado → lunes del cambio)", () => {
    const saturday9 = Date.UTC(2026, 2, 7, 14, 0); // 09:00 EST
    expect(movedInstant(saturday9, "2026-03-09", NY)).toBe(Date.UTC(2026, 2, 9, 13, 0)); // 09:00 EDT
  });

  it("resolveDrop: sólo a otro día, sólo lo movible, sólo a futuro", () => {
    const now = Date.UTC(2026, 8, 22, 18, 0);
    const chip = item();
    expect(
      resolveDrop({ item: chip, overId: dropIdOf("2026-09-24"), timeZone: BA, now }),
    ).toEqual({
      item: chip,
      scheduledAtUtc: Date.UTC(2026, 8, 24, 12, 7),
    });
    expect(
      resolveDrop({ item: chip, overId: dropIdOf("2026-09-23"), timeZone: BA, now }),
    ).toBeNull();
    expect(resolveDrop({ item: chip, overId: null, timeZone: BA, now })).toBeNull();
    expect(resolveDrop({ item: chip, overId: "post:x", timeZone: BA, now })).toBeNull();
    expect(
      resolveDrop({ item: chip, overId: dropIdOf("2026-09-21"), timeZone: BA, now }),
    ).toBeNull();
    expect(
      resolveDrop({
        item: item({ movable: false }),
        overId: dropIdOf("2026-09-24"),
        timeZone: BA,
        now,
      }),
    ).toBeNull();
    expect(
      resolveDrop({ item: undefined, overId: dropIdOf("2026-09-24"), timeZone: BA, now }),
    ).toBeNull();
    expect(dayOfDropId("day:2026-09-24")).toBe("2026-09-24");
  });
});

describe("rangos y reparto", () => {
  it("la semana empieza en domingo y el rango lleva un día de margen", () => {
    expect(weekStartOf("2026-09-23")).toBe("2026-09-20");
    expect(weekStartOf("2026-09-20")).toBe("2026-09-20");
    const range = queryRange(monthRange({ year: 2026, month: 9 }), BA);
    expect(range.from).toBe(Date.UTC(2026, 7, 31, 3, 0));
    expect(range.to).toBe(Date.UTC(2026, 9, 2, 3, 0));
  });

  it("reparte por día local y ordena por hora", () => {
    const late = item({
      id: "00000000-0000-4000-8000-000000000002",
      at: Date.UTC(2026, 8, 24, 1, 0),
    });
    const early = item({ at: Date.UTC(2026, 8, 23, 11, 0) });
    const byDay = itemsByDay([late, early], BA);
    // 01:00Z del 24 es el 23 a las 22:00 en BA.
    expect(byDay.get("2026-09-23")?.map((i) => i.at)).toEqual([early.at, late.at]);
  });
});
