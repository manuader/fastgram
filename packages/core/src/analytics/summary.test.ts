import { describe, expect, it } from "vitest";

import { summarizeAnalytics, type AnalyticsPostInput } from "./summary.js";

const NOW = Date.parse("2026-09-24T12:00:00Z");

const post = (over: Partial<AnalyticsPostInput>): AnalyticsPostInput => ({
  postId: over.postId ?? Math.random().toString(36).slice(2),
  brandId: "b1",
  network: "instagram",
  format: "slideshow",
  postedAtMs: NOW - 3_600_000,
  syncedAtMs: NOW,
  views: 100,
  likes: 10,
  comments: 0,
  shares: 0,
  postUrl: null,
  caption: null,
  ...over,
});

describe("summarizeAnalytics", () => {
  it("NFR-016: un post pre-sync cuenta como post pendiente y no suma sus ceros", () => {
    const s = summarizeAnalytics([
      post({ views: 100, likes: 10 }),
      post({ syncedAtMs: null, views: 0, likes: 0 }),
    ]);
    expect(s.totals).toMatchObject({
      posts: 2,
      syncedPosts: 1,
      pendingSync: 1,
      views: 100,
      likes: 10,
    });
    expect(s.totals.engagementRate).toBeCloseTo(0.1);
  });

  it("una métrica que la red no da no suma, y la cobertura lo dice", () => {
    const s = summarizeAnalytics([
      post({ network: "instagram", shares: 4 }),
      post({ network: "facebook", shares: null }),
    ]);
    expect(s.totals.shares).toBe(4);
    expect(s.totals.metricCoverage.shares).toBe(1);
  });

  it("sin views conocidas, el engagement rate es null (no 0 %)", () => {
    const s = summarizeAnalytics([post({ views: null })]);
    expect(s.totals.engagementRate).toBeNull();
  });

  it("desglose por red y por formato, en el orden pedido", () => {
    const s = summarizeAnalytics(
      [
        post({ network: "x", format: "wall-of-text" }),
        post({ network: "instagram", format: "slideshow" }),
        post({ network: "instagram", format: "green-screen" }),
      ],
      {
        networkOrder: ["instagram", "tiktok", "x"],
        formatOrder: ["slideshow", "wall-of-text", "green-screen", "video-hook"],
      },
    );
    expect(s.byNetwork.map((r) => [r.key, r.posts])).toEqual([
      ["instagram", 2],
      ["x", 1],
    ]);
    expect(s.byFormat.map((r) => r.key)).toEqual([
      "slideshow",
      "wall-of-text",
      "green-screen",
    ]);
  });

  it("top posts: sólo sincronizados, por views", () => {
    const s = summarizeAnalytics([
      post({ postId: "a", views: 10 }),
      post({ postId: "b", views: 500 }),
      post({ postId: "c", views: 9999, syncedAtMs: null }),
    ]);
    expect(s.topPosts.map((p) => p.postId)).toEqual(["b", "a"]);
    expect(s.lastSyncedAtMs).toBe(NOW);
  });

  it("vacío: todo en cero y sin tasa ni último sync", () => {
    const s = summarizeAnalytics([]);
    expect(s.totals.posts).toBe(0);
    expect(s.totals.engagementRate).toBeNull();
    expect(s.lastSyncedAtMs).toBeNull();
    expect(s.byNetwork).toEqual([]);
  });
});
