import { describe, expect, it } from "vitest";

import {
  formatAgo,
  formatCount,
  formatRate,
  formatShares,
  metricOf,
  signedDelta,
} from "./format";

const totals = {
  posts: 3,
  syncedPosts: 2,
  pendingSync: 1,
  views: 1200,
  likes: 30,
  comments: 4,
  shares: 0,
  metricCoverage: { views: 2, likes: 2, comments: 2, shares: 0 },
  engagementRate: 0.028,
};

describe("formato de analytics", () => {
  it("lo desconocido es —, nunca 0 (NFR-016)", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatRate(null)).toBe("—");
    expect(metricOf(totals, "shares")).toBeNull();
    expect(metricOf(totals, "views")).toBe(1200);
  });

  it("números compactos y tasas", () => {
    expect(formatCount(950)).toBe("950");
    expect(formatCount(12_345)).toBe("12.3K");
    expect(formatRate(0.028)).toBe("2.80%");
    expect(formatRate(0.25)).toBe("25.0%");
  });

  it("proporciones de la barra de formatos", () => {
    const rows = [
      { ...totals, key: "slideshow", posts: 3 },
      { ...totals, key: "wall-of-text", posts: 1 },
    ];
    expect(formatShares(rows).map((r) => r.share)).toEqual([0.75, 0.25]);
    expect(formatShares([])).toEqual([]);
  });

  it("hace cuánto y deltas con signo", () => {
    expect(formatAgo(0, 30_000)).toBe("just now");
    expect(formatAgo(0, 5 * 60_000)).toBe("5 min ago");
    expect(formatAgo(0, 3 * 3_600_000)).toBe("3 h ago");
    expect(formatAgo(0, 72 * 3_600_000)).toBe("3 d ago");
    expect(signedDelta(25, 35)).toBe("+10");
    expect(signedDelta(25, 20)).toBe("-5");
  });
});
