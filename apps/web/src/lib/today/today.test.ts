import { calendarItemSchema, type CalendarItem } from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import {
  buildTodayView,
  dayPartOf,
  DRAFTS_LOOKBACK_DAYS,
  isVideoUrl,
  olderDrafts,
  todayWindow,
} from "./today";

const BRAND = "11111111-1111-4111-8111-111111111111";
const NOW = Date.parse("2026-09-24T15:00:00.000Z");
let seq = 0;

function item(status: CalendarItem["status"], at: string): CalendarItem {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return calendarItemSchema.parse({
    kind: status === "PLANNED" ? "slot" : "post",
    id,
    brandId: BRAND,
    brandName: "Acme",
    contentId: id,
    network: "instagram",
    status,
    at: Date.parse(at),
    movable: false,
  });
}

describe("todayWindow", () => {
  it("usa la medianoche de la zona, no la de UTC", () => {
    // 2026-09-24 15:00Z es 12:00 en Buenos Aires (UTC−3).
    const w = todayWindow(NOW, "America/Argentina/Buenos_Aires");
    expect(w.todayKey).toBe("2026-09-24");
    expect(new Date(w.dayStart).toISOString()).toBe("2026-09-24T03:00:00.000Z");
    expect(new Date(w.dayEnd).toISOString()).toBe("2026-09-25T03:00:00.000Z");
    expect(w.dayStart - w.queryFrom).toBe(DRAFTS_LOOKBACK_DAYS * 86_400_000);
  });

  it("de noche en UTC−3 ya es mañana en UTC, y el día es el local", () => {
    const late = Date.parse("2026-09-25T01:30:00.000Z"); // 22:30 del 24 en BA
    expect(todayWindow(late, "America/Argentina/Buenos_Aires").todayKey).toBe(
      "2026-09-24",
    );
  });
});

describe("buildTodayView", () => {
  const w = todayWindow(NOW, "UTC");

  it("ordena el timeline por hora y deja afuera cancelados, borrados y otros días", () => {
    const late = item("SCHEDULED", "2026-09-24T18:00:00Z");
    const early = item("POSTED", "2026-09-24T09:00:00Z");
    const mid = item("PLANNED", "2026-09-24T12:00:00Z");
    const view = buildTodayView(
      [
        late,
        item("CANCELLED", "2026-09-24T10:00:00Z"),
        early,
        item("SCHEDULED", "2026-09-25T09:00:00Z"),
        mid,
        item("POSTED", "2026-09-23T23:59:00Z"),
      ],
      w,
      NOW,
    );
    expect(view.timeline.map((i) => i.id)).toEqual([early.id, mid.id, late.id]);
  });

  it("cuenta publicados y programados de hoy; AWAITING_RECONNECT no es 'programado'", () => {
    const view = buildTodayView(
      [
        item("POSTED", "2026-09-24T09:00:00Z"),
        item("POSTED", "2026-09-24T10:00:00Z"),
        item("SCHEDULED", "2026-09-24T18:00:00Z"),
        item("BUILDING", "2026-09-24T19:00:00Z"),
        item("PLANNED", "2026-09-24T20:00:00Z"),
        item("UPLOADING_TO_TIKTOK", "2026-09-24T14:59:00Z"),
        item("AWAITING_RECONNECT", "2026-09-24T13:00:00Z"),
      ],
      w,
      NOW,
    );
    expect(view.counts.postedToday).toBe(2);
    expect(view.counts.scheduledToday).toBe(4);
  });

  it("fallidos: los últimos 7 días desde ahora, el más nuevo primero", () => {
    const recent = item("FAILED", "2026-09-24T08:00:00Z");
    const older = item("FAILED", "2026-09-18T08:00:00Z");
    const view = buildTodayView(
      [older, item("FAILED", "2026-09-17T14:59:00Z"), recent],
      w,
      NOW,
    );
    expect(view.failed.map((i) => i.id)).toEqual([recent.id, older.id]);
    expect(view.counts.failedRecent).toBe(2);
  });

  it("borradores de TikTok de toda la ventana, el que más espera primero", () => {
    const today = item("IN_USER_INBOX", "2026-09-24T08:00:00Z");
    const old = item("IN_USER_INBOX", "2026-09-02T08:00:00Z");
    const view = buildTodayView([today, old], w, NOW);
    expect(view.drafts.map((i) => i.id)).toEqual([old.id, today.id]);
    // Un borrador de hoy también está en el timeline, marcado como tal.
    expect(view.timeline.map((i) => i.id)).toEqual([today.id]);
  });
});

describe("olderDrafts", () => {
  it("es lo que el total global tiene de más, nunca negativo", () => {
    expect(olderDrafts(5, 3)).toBe(2);
    expect(olderDrafts(1, 3)).toBe(0);
  });
});

describe("dayPartOf", () => {
  it("mañana, tarde y noche en la zona pedida", () => {
    expect(dayPartOf(Date.parse("2026-09-24T09:00:00Z"), "UTC")).toBe("morning");
    expect(dayPartOf(Date.parse("2026-09-24T15:00:00Z"), "UTC")).toBe("afternoon");
    expect(dayPartOf(Date.parse("2026-09-24T22:00:00Z"), "UTC")).toBe("evening");
    expect(dayPartOf(Date.parse("2026-09-24T02:00:00Z"), "UTC")).toBe("evening");
    // 15:00Z son las 12:00 en BA: el borde de la tarde es inclusivo.
    expect(dayPartOf(NOW, "America/Argentina/Buenos_Aires")).toBe("afternoon");
  });
});

describe("isVideoUrl", () => {
  it("mira la extensión del path, no la query", () => {
    expect(isVideoUrl("https://cdn.test/a/out.mp4?sig=1")).toBe(true);
    expect(isVideoUrl("https://cdn.test/a/slide.png?x=.mp4")).toBe(false);
    expect(isVideoUrl("no es una url")).toBe(false);
  });
});
