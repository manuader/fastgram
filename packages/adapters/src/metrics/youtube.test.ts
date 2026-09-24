/**
 * `YouTubeMetrics` contra un `fetch` falso con la forma de
 * https://developers.google.com/youtube/v3/docs/videos/list (`items[]` con
 * `statistics` en texto) y los errores de
 * https://developers.google.com/youtube/v3/docs/errors .
 */
import { isPortError } from "@fastgram/ports";
import { describe, expect, it } from "vitest";

import { FakeFetch, type Route } from "../publishers/__tests__/fake-fetch.js";
import { YouTubeMetrics, YOUTUBE_METRICS_CAPABILITIES } from "./index.js";

const ACCOUNT = { accessToken: "ya29-tok" };

const list = (json: unknown, status = 200): Route => ({
  method: "GET",
  match: "/youtube/v3/videos?part=statistics",
  replies: [{ status, json }],
});

describe("YouTubeMetrics · PU-LATER-001", () => {
  it("views/likes/comments desde statistics; los ids que no vuelven son missing", async () => {
    const fake = new FakeFetch([
      list({
        kind: "youtube#videoListResponse",
        items: [
          {
            id: "vid-1",
            statistics: {
              viewCount: "1520",
              likeCount: "33",
              favoriteCount: "0",
              commentCount: "4",
            },
          },
        ],
      }),
    ]);
    const result = await new YouTubeMetrics({ fetch: fake.fetch }).fetch({
      account: ACCOUNT,
      externalPostIds: ["vid-1", "vid-borrado", "vid-1"],
    });
    expect(result).toEqual({
      items: [{ externalPostId: "vid-1", views: 1520, likes: 33, comments: 4 }],
      missing: ["vid-borrado"],
      unavailable: [],
    });
    const url = new URL(fake.calls[0]?.url ?? "https://x");
    expect(url.searchParams.get("id")).toBe("vid-1,vid-borrado");
    expect(fake.calls[0]?.headers["Authorization"]).toBe("Bearer ya29-tok");
  });

  it("likeCount oculto no es cero: no está", async () => {
    const fake = new FakeFetch([
      list({ items: [{ id: "v", statistics: { viewCount: "10", commentCount: "0" } }] }),
    ]);
    const { items } = await new YouTubeMetrics({ fetch: fake.fetch }).fetch({
      account: ACCOUNT,
      externalPostIds: ["v"],
    });
    expect(items[0]).toEqual({ externalPostId: "v", views: 10, comments: 0 });
  });

  it("401 → unauthorized; 403 → forbidden; quotaExceeded → rate_limited", async () => {
    const run = async (status: number, reason: string) =>
      new YouTubeMetrics({
        fetch: new FakeFetch([
          list({ error: { code: status, errors: [{ reason }] } }, status),
        ]).fetch,
      })
        .fetch({ account: ACCOUNT, externalPostIds: ["v"] })
        .catch((e: unknown) => e);
    const codeOf = (e: unknown) => (isPortError(e) ? e.code : "no");
    expect(codeOf(await run(401, "authError"))).toBe("unauthorized");
    expect(codeOf(await run(403, "forbidden"))).toBe("forbidden");
    expect(codeOf(await run(403, "quotaExceeded"))).toBe("rate_limited");
  });

  it("más ids que el lote: bad_request sin llamar", async () => {
    const fake = new FakeFetch([]);
    const error: unknown = await new YouTubeMetrics({ fetch: fake.fetch })
      .fetch({
        account: ACCOUNT,
        externalPostIds: Array.from(
          { length: YOUTUBE_METRICS_CAPABILITIES.maxBatch + 1 },
          (_, i) => `v${String(i)}`,
        ),
      })
      .catch((e: unknown) => e);
    expect(isPortError(error) && error.code).toBe("bad_request");
    expect(fake.calls).toHaveLength(0);
  });
});
