/**
 * La aritmética del Calendar: bordes de mes, DST, orden y contadores.
 *
 * Toda zona va **explícita** en cada llamada. Ningún test depende de la zona de
 * la máquina que lo corre: si dependiera, el borde de mes pasaría en la
 * laptop de Buenos Aires y fallaría en el CI en UTC —o al revés—, que es la
 * forma más cara de descubrirlo.
 */
import { describe, expect, it } from "vitest";
import {
  countInMonth,
  dayKeyOf,
  daysInMonth,
  formatChipTime,
  formatDayLabel,
  formatMonthTitle,
  groupByDay,
  headerCounts,
  monthGrid,
  monthOf,
  shiftMonth,
} from "./calendar";

const BA = "America/Argentina/Buenos_Aires"; // UTC-3, sin DST
const NY = "America/New_York"; // con DST

describe("la cuadrícula del mes", () => {
  it("septiembre 2026 empieza en martes: dos celdas de relleno, cinco semanas", () => {
    const weeks = monthGrid({ year: 2026, month: 9 });
    expect(weeks).toHaveLength(5);
    expect(weeks.every((week) => week.length === 7)).toBe(true);
    expect(weeks[0]?.slice(0, 3)).toEqual([null, null, { key: "2026-09-01", day: 1 }]);
    // El 30 cae en miércoles; jueves a sábado son relleno.
    expect(weeks[4]?.slice(3)).toEqual([
      { key: "2026-09-30", day: 30 },
      null,
      null,
      null,
    ]);
  });

  it("febrero 2026 empieza en domingo y dura 28: exactamente cuatro semanas, sin relleno", () => {
    const weeks = monthGrid({ year: 2026, month: 2 });
    expect(weeks).toHaveLength(4);
    expect(weeks.flat().filter((cell) => cell === null)).toHaveLength(0);
  });

  it("los días de cada mes, incluido el bisiesto", () => {
    expect(daysInMonth({ year: 2028, month: 2 })).toBe(29);
    expect(daysInMonth({ year: 2026, month: 2 })).toBe(28);
    expect(daysInMonth({ year: 2026, month: 12 })).toBe(31);
    const cells = monthGrid({ year: 2028, month: 2 }).flat();
    expect(cells.filter((cell) => cell !== null).at(-1)).toEqual({
      key: "2028-02-29",
      day: 29,
    });
  });

  it("un mes de seis semanas: agosto 2026 empieza en sábado", () => {
    expect(monthGrid({ year: 2026, month: 8 })).toHaveLength(6);
  });
});

describe("la navegación de meses cruza el año", () => {
  it("diciembre + 1 es enero del siguiente, enero − 1 es diciembre del anterior", () => {
    expect(shiftMonth({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(shiftMonth({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(shiftMonth({ year: 2026, month: 9 }, 13)).toEqual({ year: 2027, month: 10 });
    expect(shiftMonth({ year: 2026, month: 9 }, -21)).toEqual({ year: 2024, month: 12 });
  });
});

describe("el día de un instante depende de la zona", () => {
  // 2026-10-01T02:30Z = 30 de septiembre, 23:30 en Buenos Aires.
  const EDGE = Date.UTC(2026, 9, 1, 2, 30);

  it("el mismo instante es 30 de septiembre en Buenos Aires y 1 de octubre en UTC", () => {
    expect(dayKeyOf(EDGE, BA)).toBe("2026-09-30");
    expect(dayKeyOf(EDGE, "UTC")).toBe("2026-10-01");
    expect(monthOf(EDGE, BA)).toEqual({ year: 2026, month: 9 });
    expect(monthOf(EDGE, "UTC")).toEqual({ year: 2026, month: 10 });
  });

  it("y el mes que lo cuenta cambia con ella", () => {
    const posts = [{ _id: "a", scheduledAtUtc: EDGE }];
    expect(countInMonth(groupByDay(posts, BA), { year: 2026, month: 9 })).toBe(1);
    expect(countInMonth(groupByDay(posts, BA), { year: 2026, month: 10 })).toBe(0);
    expect(countInMonth(groupByDay(posts, "UTC"), { year: 2026, month: 9 })).toBe(0);
    expect(countInMonth(groupByDay(posts, "UTC"), { year: 2026, month: 10 })).toBe(1);
  });

  it("fin de año: 1 de enero 01:00 UTC es 31 de diciembre en Buenos Aires", () => {
    expect(dayKeyOf(Date.UTC(2027, 0, 1, 1, 0), BA)).toBe("2026-12-31");
  });
});

describe("DST: la hora que se repite (Nueva York, 1 de noviembre de 2026)", () => {
  // A las 2:00 EDT el reloj vuelve a la 1:00 EST: la 1:30 existe dos veces.
  const FIRST_130 = Date.UTC(2026, 10, 1, 5, 30); // 1:30 EDT (UTC-4)
  const SECOND_130 = Date.UTC(2026, 10, 1, 6, 30); // 1:30 EST (UTC-5)
  const BEFORE_MIDNIGHT = Date.UTC(2026, 10, 1, 3, 59); // 23:59 EDT del 31/10

  it("las dos 1:30 son del mismo día y se escriben igual", () => {
    expect(dayKeyOf(FIRST_130, NY)).toBe("2026-11-01");
    expect(dayKeyOf(SECOND_130, NY)).toBe("2026-11-01");
    expect(formatChipTime(FIRST_130, NY)).toBe("1:30 AM");
    expect(formatChipTime(SECOND_130, NY)).toBe("1:30 AM");
    expect(dayKeyOf(BEFORE_MIDNIGHT, NY)).toBe("2026-10-31");
  });

  it("y se ordenan por instante, no por el texto de la hora", () => {
    const byDay = groupByDay(
      [
        // `_id` al revés del instante: si el orden fuera por id o por texto,
        // saldrían invertidos.
        { _id: "a", scheduledAtUtc: SECOND_130 },
        { _id: "b", scheduledAtUtc: FIRST_130 },
      ],
      NY,
    );
    expect(byDay.get("2026-11-01")?.map((post) => post._id)).toEqual(["b", "a"]);
  });

  it("el día en que se adelanta el reloj (8 de marzo) no pierde posts", () => {
    // 2:30 no existe ese día en Nueva York; 07:30Z es 3:30 EDT.
    expect(dayKeyOf(Date.UTC(2026, 2, 8, 7, 30), NY)).toBe("2026-03-08");
    expect(formatChipTime(Date.UTC(2026, 2, 8, 7, 30), NY)).toBe("3:30 AM");
  });
});

describe("el reparto por día", () => {
  it("ordena por hora dentro del día y desempata por id (FR-110, aceptación 2)", () => {
    const at = (h: number, m: number) => Date.UTC(2026, 8, 22, h, m);
    const byDay = groupByDay(
      [
        { _id: "c", scheduledAtUtc: at(18, 0) },
        { _id: "b", scheduledAtUtc: at(9, 5) },
        { _id: "a", scheduledAtUtc: at(9, 5) },
        { _id: "d", scheduledAtUtc: at(23, 56) },
      ],
      "UTC",
    );
    expect(byDay.get("2026-09-22")?.map((post) => post._id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ]);
  });

  it("un post publicado va al día en que salió, no al que estaba programado", () => {
    const byDay = groupByDay(
      [
        {
          _id: "slow-lane",
          scheduledAtUtc: Date.UTC(2026, 8, 22, 12),
          postedAt: Date.UTC(2026, 8, 24, 12),
        },
      ],
      "UTC",
    );
    expect(byDay.has("2026-09-22")).toBe(false);
    expect(byDay.get("2026-09-24")).toHaveLength(1);
  });
});

describe("los contadores de cabecera (F-143)", () => {
  it("✓ = POSTED, 📥 = IN_USER_INBOX, 📅 = SCHEDULED + BUILDING; el resto en ninguno", () => {
    const statuses = [
      "POSTED",
      "POSTED",
      "IN_USER_INBOX",
      "SCHEDULED",
      "BUILDING",
      "FAILED",
      "CANCELLED",
      "UPLOADING_TO_TIKTOK",
      "AWAITING_RECONNECT",
      "CREATED",
    ] as const;
    expect(headerCounts(statuses.map((status) => ({ status })))).toEqual({
      posted: 2,
      inbox: 1,
      scheduled: 2,
    });
  });

  it("vacío es cero, no ausente", () => {
    expect(headerCounts([])).toEqual({ posted: 0, inbox: 0, scheduled: 0 });
  });
});

describe("el formato", () => {
  it("el título es `MMMM YYYY` (F-140)", () => {
    expect(formatMonthTitle({ year: 2026, month: 9 })).toBe("September 2026");
    expect(formatMonthTitle({ year: 2027, month: 1 })).toBe("January 2027");
  });

  it("la hora del chip es `11:56 PM` (PRD:1659), en la zona pedida", () => {
    const instant = Date.UTC(2026, 8, 22, 23, 56);
    expect(formatChipTime(instant, "UTC")).toBe("11:56 PM");
    expect(formatChipTime(instant, BA)).toBe("8:56 PM");
  });

  it("el nombre de una celda no depende de la zona: es una fecha civil", () => {
    expect(formatDayLabel("2026-09-22")).toBe("Tuesday, September 22");
    expect(formatDayLabel("2026-10-01")).toBe("Thursday, October 1");
  });
});
