import { describe, expect, it } from "vitest";

import {
  DISCOVERY_LIMITS,
  discoveryBackoffSeconds,
  engagementScoreOf,
  matchKeywords,
  normalizeDiscoverySettings,
  normalizeSubreddit,
  parseRateLimitHeaders,
  parseRedditPostUrl,
  planAfterResponse,
  redditThreadUrl,
  selectCandidates,
  type RedditPostCandidate,
} from "./discovery.js";

const now = new Date("2026-09-24T12:00:00Z");
const post = (over: Partial<RedditPostCandidate> = {}): RedditPostCandidate => ({
  id: "abc123",
  subreddit: "freelance",
  title: "Best invoicing tool?",
  selftext: "",
  author: "someone",
  score: 3,
  numComments: 2,
  createdUtc: now.getTime() / 1000 - 3600,
  permalink: "/r/freelance/comments/abc123/best/",
  over18: false,
  locked: false,
  stickied: false,
  ...over,
});

describe("settings (F-192)", () => {
  it("normaliza nombres de subreddit y deduplica", () => {
    expect(normalizeSubreddit("r/Freelance")).toBe("Freelance");
    expect(normalizeSubreddit("https://www.reddit.com/r/smallbusiness/")).toBe(
      "smallbusiness",
    );
    expect(normalizeSubreddit("bad name")).toBeNull();
    const r = normalizeDiscoverySettings({
      subreddits: ["freelance", "/r/Freelance", "sb"],
      keywords: [" Invoice ", "invoice", "billing tool"],
    });
    expect(r).toEqual({
      ok: true,
      subreddits: ["freelance", "sb"],
      keywords: ["invoice", "billing tool"],
    });
  });

  it("rechaza lo inválido y lo que pasa los topes", () => {
    expect(
      normalizeDiscoverySettings({ subreddits: ["ok_one", "no way"], keywords: [] }),
    ).toEqual({
      ok: false,
      invalid: ["no way"],
      field: "subreddits",
    });
    const many = Array.from(
      { length: DISCOVERY_LIMITS.maxSubreddits + 1 },
      (_, i) => `sub${i}`,
    );
    expect(normalizeDiscoverySettings({ subreddits: many, keywords: [] }).ok).toBe(false);
  });
});

describe("candidatos (F-191)", () => {
  it("palabra entera, sin distinguir mayúsculas", () => {
    expect(matchKeywords("Any good INVOICE app?", ["invoice", "app", "tax"])).toEqual([
      "invoice",
      "app",
    ]);
    expect(matchKeywords("apple pie", ["app"])).toEqual([]);
  });

  it("dedupe contra lo conocido y filtros de seguridad", () => {
    const r = selectCandidates({
      posts: [
        post(),
        post({ id: "known1" }),
        post({ id: "n1", over18: true }),
        post({ id: "l1", locked: true }),
        post({ id: "s1", stickied: true }),
        post({ id: "o1", createdUtc: now.getTime() / 1000 - 100 * 3600 }),
        post({ id: "me1", author: "MyUser" }),
        post({ id: "k1", title: "nothing relevant" }),
        post(),
      ],
      keywords: ["invoicing"],
      knownIds: new Set(["known1"]),
      ownUsername: "myuser",
      now,
    });
    expect(r.selected.map((s) => s.post.id)).toEqual(["abc123"]);
    expect(r.selected[0]?.matched).toEqual(["invoicing"]);
    expect(r.skipped).toEqual({
      known: 2,
      nsfw: 1,
      locked: 1,
      stickied: 1,
      too_old: 1,
      own_post: 1,
      no_keyword: 1,
    });
  });

  it("most engaged: comentarios pesan el doble", () => {
    expect(engagementScoreOf({ score: 10, numComments: 5 })).toBe(20);
    expect(engagementScoreOf({ score: -3, numComments: 0 })).toBe(0);
  });
});

describe("límite de tasa (headers X-Ratelimit-*)", () => {
  const headers = (h: Record<string, string>) => (n: string) => h[n] ?? null;

  it("parsea y sigue con la pausa mínima mientras sobre margen", () => {
    const s = parseRateLimitHeaders(
      headers({
        "x-ratelimit-used": "10",
        "x-ratelimit-remaining": "50.0",
        "x-ratelimit-reset": "33",
      }),
    );
    expect(s).toEqual({ used: 10, remaining: 50, resetSeconds: 33 });
    expect(planAfterResponse(s)).toEqual({ kind: "continue", waitMs: 1_000 });
  });

  it("corta hasta el reset cuando quedan pocas", () => {
    const s = parseRateLimitHeaders(
      headers({ "x-ratelimit-remaining": "3", "x-ratelimit-reset": "12.5" }),
    );
    expect(planAfterResponse(s)).toEqual({ kind: "pause", retryAfterSeconds: 13 });
  });

  it("sin headers sigue; backoff exponencial con tope", () => {
    expect(planAfterResponse(parseRateLimitHeaders(() => null)).kind).toBe("continue");
    expect([0, 1, 2, 10].map(discoveryBackoffSeconds)).toEqual([60, 120, 240, 3600]);
  });
});

describe("URLs", () => {
  it("post de Reddit → subreddit + id; lo demás no", () => {
    expect(
      parseRedditPostUrl(
        "https://www.reddit.com/r/freelance/comments/1abcde/some_title/",
      ),
    ).toEqual({
      subreddit: "freelance",
      postId: "1abcde",
    });
    expect(parseRedditPostUrl("https://old.reddit.com/r/x_y/comments/ZZ12/")).toEqual({
      subreddit: "x_y",
      postId: "zz12",
    });
    expect(
      parseRedditPostUrl("https://evil.com/r/freelance/comments/1abcde/"),
    ).toBeNull();
    expect(parseRedditPostUrl("javascript:alert(1)")).toBeNull();
    expect(redditThreadUrl("/r/a/comments/b/")).toBe(
      "https://www.reddit.com/r/a/comments/b/",
    );
  });
});
