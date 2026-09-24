import { describe, expect, it } from "vitest";

import { engagementRate } from "./engagement.js";
import {
  METRICS_SYNC_WINDOW_DAYS,
  isMetricsSyncDue,
  metricsSyncIntervalMs,
} from "./sync-policy.js";

const H = 3_600_000;
const D = 24 * H;
const NOW = Date.parse("2026-09-24T12:07:00Z");

describe("isMetricsSyncDue", () => {
  it("nunca sincronizado y dentro de la ventana: sí", () => {
    expect(
      isMetricsSyncDue(
        { postedAtMs: NOW - H, syncedAtMs: null, costPerPostReadUsd: 0 },
        NOW,
      ),
    ).toBe(true);
  });

  it(`fuera de los ${String(METRICS_SYNC_WINDOW_DAYS)} días: nunca, aunque no se haya leído`, () => {
    expect(
      isMetricsSyncDue(
        { postedAtMs: NOW - 31 * D, syncedAtMs: null, costPerPostReadUsd: 0 },
        NOW,
      ),
    ).toBe(false);
  });

  it("< 48 h: cada hora, con holgura para el cron (59 min 30 s ya está debido)", () => {
    const c = { postedAtMs: NOW - 5 * H, costPerPostReadUsd: 0 };
    expect(isMetricsSyncDue({ ...c, syncedAtMs: NOW - 59.5 * 60_000 }, NOW)).toBe(true);
    expect(isMetricsSyncDue({ ...c, syncedAtMs: NOW - 30 * 60_000 }, NOW)).toBe(false);
  });

  it("≥ 48 h: cada 24 h", () => {
    const c = { postedAtMs: NOW - 3 * D, costPerPostReadUsd: 0 };
    expect(isMetricsSyncDue({ ...c, syncedAtMs: NOW - 2 * H }, NOW)).toBe(false);
    expect(isMetricsSyncDue({ ...c, syncedAtMs: NOW - 24 * H }, NOW)).toBe(true);
  });

  it("una red que cobra la lectura (X) va cada 24 h también en las primeras 48 h", () => {
    expect(metricsSyncIntervalMs(H, 0.005)).toBe(D);
    expect(
      isMetricsSyncDue(
        { postedAtMs: NOW - 5 * H, syncedAtMs: NOW - 2 * H, costPerPostReadUsd: 0.005 },
        NOW,
      ),
    ).toBe(false);
  });
});

describe("engagementRate", () => {
  it("(likes+comments+shares)/views", () => {
    expect(engagementRate({ views: 200, likes: 10, comments: 5, shares: 5 })).toBe(0.1);
  });

  it("sin views conocidas o con 0 views no hay tasa (no es 0 %)", () => {
    expect(engagementRate({ views: null, likes: 1, comments: 0, shares: 0 })).toBeNull();
    expect(engagementRate({ views: 0, likes: 0, comments: 0, shares: 0 })).toBeNull();
  });

  it("shares desconocido no suma", () => {
    expect(engagementRate({ views: 100, likes: 10, comments: 0, shares: null })).toBe(
      0.1,
    );
  });
});
