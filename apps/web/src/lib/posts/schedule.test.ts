/**
 * La lógica pura del diálogo de Schedule (sprint 7): topes por red por code
 * point, hora local de la marca ↔ UTC (con cambio de horario), borradores
 * iniciales y el cuerpo de `targets`.
 */
import type { ScheduleOptions } from "@fastgram/contracts";
import { describe, expect, it } from "vitest";

import {
  codePoints,
  defaultScheduleMs,
  draftProblems,
  initialDrafts,
  isOverLimit,
  needsPublishConfirmation,
  targetsOf,
  utcToZoned,
  zonedToUtc,
  type NetworkDraft,
} from "./schedule";

const CONN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function options(over: Partial<ScheduleOptions> = {}): ScheduleOptions {
  const net = (network: ScheduleOptions["networks"][number]["network"], extra = {}) => ({
    network,
    inStrategy: false,
    suggestedAtUtc: null,
    alreadyScheduled: false,
    connections: [],
    caption: "copy",
    description: null,
    ...extra,
  });
  return {
    contentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as ScheduleOptions["contentId"],
    contentType: "slideshow",
    contentStatus: "CREATED",
    timezone: "America/Argentina/Buenos_Aires",
    suggestedAtUtc: null,
    xAllowLinks: false,
    networks: [
      net("instagram", {
        inStrategy: true,
        connections: [{ connectionId: CONN, username: "marca" }],
      }),
      net("tiktok", { inStrategy: true, description: "cuerpo" }),
      net("x", {
        inStrategy: false,
        connections: [{ connectionId: CONN, username: "marca" }],
      }),
      net("reddit"),
    ] as ScheduleOptions["networks"],
    ...over,
  };
}

const draft = (over: Partial<NetworkDraft>): NetworkDraft => ({
  network: "instagram",
  selected: true,
  connectionId: CONN,
  caption: "hola",
  description: "",
  instagramSlideshowFormat: "carousel",
  aiContentDisclaimer: false,
  tiktokPrivacy: null,
  ...over,
});

describe("zona horaria de la marca", () => {
  it("ida y vuelta en Buenos Aires (UTC-3)", () => {
    const ms = zonedToUtc("2026-09-25", "14:30", "America/Argentina/Buenos_Aires");
    expect(ms).toBe(Date.UTC(2026, 8, 25, 17, 30));
    expect(utcToZoned(ms ?? 0, "America/Argentina/Buenos_Aires")).toEqual({
      date: "2026-09-25",
      time: "14:30",
    });
  });

  it("respeta el cambio de horario (Madrid, verano e invierno)", () => {
    expect(zonedToUtc("2026-07-01", "10:00", "Europe/Madrid")).toBe(
      Date.UTC(2026, 6, 1, 8, 0),
    );
    expect(zonedToUtc("2026-12-01", "10:00", "Europe/Madrid")).toBe(
      Date.UTC(2026, 11, 1, 9, 0),
    );
  });

  it("basura no parsea", () => {
    expect(zonedToUtc("mañana", "10:00", "UTC")).toBeNull();
  });

  it("la hora por defecto es la sugerida si es futura; si no, en una hora redondeada", () => {
    const now = Date.UTC(2026, 8, 21, 12, 7);
    expect(defaultScheduleMs(options({ suggestedAtUtc: now + 5_000 }), now)).toBe(
      now + 5_000,
    );
    expect(defaultScheduleMs(options(), now)).toBe(Date.UTC(2026, 8, 21, 13, 15));
  });
});

describe("topes", () => {
  it("cuenta por code point", () => {
    expect(codePoints("🔥🔥")).toBe(2);
    expect(isOverLimit("🔥".repeat(280), 280)).toBe(false);
    expect(isOverLimit("a".repeat(281), 280)).toBe(true);
    expect(isOverLimit("a".repeat(9999), null)).toBe(false);
  });
});

describe("borradores", () => {
  it("sólo redes conectadas o de la estrategia; preselecciona conectadas de la estrategia", () => {
    const drafts = initialDrafts(options());
    expect(drafts.map((d) => [d.network, d.selected, d.connectionId])).toEqual([
      ["instagram", true, CONN],
      ["tiktok", false, null],
      ["x", false, CONN],
    ]);
    expect(drafts.find((d) => d.network === "tiktok")?.description).toBe("cuerpo");
  });

  it("problemas: nada elegido, sin conexión, de más", () => {
    expect(draftProblems([draft({ selected: false })])).toEqual([
      { kind: "none_selected" },
    ]);
    expect(draftProblems([draft({ network: "tiktok", connectionId: null })])).toEqual([
      { kind: "no_connection", network: "tiktok" },
    ]);
    expect(draftProblems([draft({ network: "x", caption: "a".repeat(281) })])).toEqual([
      { kind: "too_long", network: "x", field: "caption" },
    ]);
    expect(draftProblems([draft({})])).toEqual([]);
  });

  it("targets: TikTok manda title/description; IG con slideshow lleva el formato", () => {
    const targets = targetsOf(
      [
        draft({ instagramSlideshowFormat: "reel" }),
        draft({ network: "tiktok", caption: "t", description: "d" }),
        draft({
          network: "youtube",
          caption: "t",
          description: "d",
          aiContentDisclaimer: true,
        }),
        draft({ network: "x", selected: false }),
      ],
      "slideshow",
    );
    expect(targets).toEqual([
      {
        platform: "instagram",
        connectionId: CONN,
        caption: "hola",
        instagramSlideshowFormat: "reel",
      },
      { platform: "tiktok", connectionId: CONN, title: "t", description: "d" },
      {
        platform: "youtube",
        connectionId: CONN,
        aiContentDisclaimer: true,
        caption: "t",
        description: "d",
      },
    ]);
    // Un video no manda formato de slideshow.
    expect(targetsOf([draft({})], "wall-of-text")[0]).not.toHaveProperty(
      "instagramSlideshowFormat",
    );
  });
});

describe("needsPublishConfirmation", () => {
  it("lee details.needsConfirmation del error", () => {
    expect(needsPublishConfirmation({ details: { needsConfirmation: true } })).toBe(true);
    expect(needsPublishConfirmation(new Error("x"))).toBe(false);
  });
});
