import { describe, expect, it } from "vitest";
import type { Automation, AutomationSlot } from "@fastgram/contracts";
import { ApiRequestError } from "../api/errors";
import {
  campaignWeeks,
  fromLocalInput,
  generationBlockedCopy,
  progressOf,
  slotFailureCopy,
  slotsByDay,
  toLocalInput,
} from "./present";

const slot = (over: Partial<AutomationSlot>): AutomationSlot => ({
  id: "s",
  index: 0,
  status: "READY",
  contentType: "wall-of-text",
  scheduledAt: Date.UTC(2026, 9, 5, 12),
  generatedText: "hola",
  texts: ["hola"],
  aiExplanation: null,
  topic: null,
  captionsByPlatform: {},
  failureReason: null,
  errorCode: null,
  contentId: null,
  preview: null,
  generationAttempts: 1,
  posts: [],
  ...over,
});

describe("present", () => {
  it("la hora local ida y vuelta, en una zona con horario de verano", () => {
    const ms = Date.UTC(2026, 9, 5, 12, 30);
    const local = toLocalInput(ms, "America/New_York");
    expect(local).toBe("2026-10-05T08:30");
    expect(fromLocalInput(local, "America/New_York")).toBe(ms);
    expect(fromLocalInput("mañana", "UTC")).toBeNull();
  });

  it("agrupa los slots por día de la campaña (su zona, no la del navegador)", () => {
    const late = slot({ id: "a", scheduledAt: Date.UTC(2026, 9, 6, 2) }); // 5/10 23:00 en BA
    const byDay = slotsByDay([late], "America/Argentina/Buenos_Aires");
    expect([...byDay.keys()]).toEqual(["2026-10-05"]);
    expect(campaignWeeks("2026-10-05", 2).map((w) => w[0])).toEqual([
      "2026-10-05",
      "2026-10-12",
    ]);
  });

  it("el progreso descuenta los que no se van a publicar", () => {
    const a = {
      status: "REVIEW",
      progress: { total: 10, byStatus: { READY: 6, FAILED_GEN: 2, CANCELLED: 2 } },
    } as unknown as Automation;
    expect(progressOf(a)).toMatchObject({ done: 6, total: 8, percent: 75 });
  });

  it("dice por qué falló un slot", () => {
    expect(
      slotFailureCopy(slot({ status: "FAILED_GEN", failureReason: "no_unique_content" })),
    ).toBe("automations.failure.noUniqueContent");
    expect(slotFailureCopy(slot({ status: "FAILED_GEN", errorCode: "no_media" }))).toBe(
      "automations.failure.noMedia",
    );
    expect(slotFailureCopy(slot({ status: "READY" }))).toBeNull();
  });

  it("traduce los bloqueos de generate (códigos del PRD y motivos nuestros)", () => {
    expect(
      generationBlockedCopy(
        new ApiRequestError({ code: "AUTOMATION_NO_CONTENT_TYPE_SELECTED", status: 422 }),
      ),
    ).toMatch(/content type/);
    expect(
      generationBlockedCopy(
        new ApiRequestError({
          code: "bad_request",
          status: 400,
          details: { reason: "AUTOMATION_YOUTUBE_REQUIRES_NO_SLIDESHOW" },
        }),
      ),
    ).toMatch(/YouTube/);
    expect(generationBlockedCopy(new Error("x"))).toBeNull();
  });
});
