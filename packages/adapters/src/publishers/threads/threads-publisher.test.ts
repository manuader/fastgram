/**
 * Threads contra un `fetch` falso con las respuestas documentadas en
 * https://developers.facebook.com/docs/threads/posts (form-encoded con
 * `access_token`), https://developers.facebook.com/docs/threads/troubleshooting
 * (`{"status":"FINISHED","id":"17889615691921648"}`) y la forma de error de la
 * Graph API.
 */
import { describe, expect, it } from "vitest";
import { describeSocialPublisherContract, type PublishRequest } from "@fastgram/ports";

import { FakeFetch, bodyOf, noSleep, type Route } from "../__tests__/fake-fetch.js";
import { ThreadsPublisher } from "./threads-publisher.js";

const ACCOUNT = {
  accountType: "oauth" as const,
  accountId: "conn-th",
  accessToken: "tok-th",
  platformUserId: "th-user",
};

const request = (over: Partial<PublishRequest> = {}): PublishRequest => ({
  account: ACCOUNT,
  media: { kind: "text", urls: [] },
  caption: "un hilo",
  idempotencyKey: `publish:${Math.random().toString(36).slice(2)}`,
  ...over,
});

const routes = (over: { container?: Route; publish?: Route } = {}): Route[] => [
  over.container ?? {
    method: "POST",
    match: /\/th-user\/threads$/,
    replies: [{ json: { id: "17889615691921648" } }],
  },
  {
    method: "GET",
    match: "/17889615691921648?",
    replies: [{ json: { status: "FINISHED", id: "17889615691921648" } }],
  },
  over.publish ?? {
    method: "POST",
    match: "/th-user/threads_publish",
    replies: [{ json: { id: "th-media-1" } }],
  },
  {
    method: "GET",
    match: "/th-media-1?",
    replies: [{ json: { permalink: "https://www.threads.net/@x/post/abc" } }],
  },
];

describe("Threads", () => {
  it("texto: contenedor TEXT form-encoded con access_token → threads_publish", async () => {
    const fake = new FakeFetch(routes());
    const publisher = new ThreadsPublisher({ fetch: fake.fetch, sleep: noSleep });

    const status = await publisher.publish(request());

    expect(status).toEqual({
      kind: "published",
      externalPostId: "th-media-1",
      permalink: "https://www.threads.net/@x/post/abc",
    });
    const create = fake.to("POST", "/th-user/threads")[0];
    expect(create?.url).toBe("https://graph.threads.net/v1.0/th-user/threads");
    expect(create?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(bodyOf(create)).toEqual({
      media_type: "TEXT",
      text: "un hilo",
      access_token: "tok-th",
    });
    expect(bodyOf(fake.to("POST", "threads_publish")[0])).toMatchObject({
      creation_id: "17889615691921648",
    });
    // El GET lleva el token en la query, como el ejemplo de threads-media.
    expect(fake.to("GET", "/17889615691921648")[0]?.url).toContain("access_token=tok-th");
  });

  it("video: media_type VIDEO con video_url", async () => {
    const fake = new FakeFetch(routes());
    const publisher = new ThreadsPublisher({ fetch: fake.fetch, sleep: noSleep });
    await publisher.publish(
      request({ media: { kind: "video", urls: ["https://t/v.mp4"] } }),
    );
    expect(bodyOf(fake.to("POST", "/th-user/threads")[0])).toMatchObject({
      media_type: "VIDEO",
      video_url: "https://t/v.mp4",
    });
  });

  it("carrusel de 3 imágenes: hijos is_carousel_item + CAROUSEL", async () => {
    const fake = new FakeFetch(
      routes({
        container: {
          method: "POST",
          match: /\/th-user\/threads$/,
          replies: [
            { json: { id: "k1" } },
            { json: { id: "k2" } },
            { json: { id: "k3" } },
            { json: { id: "17889615691921648" } },
          ],
        },
      }),
    );
    const publisher = new ThreadsPublisher({ fetch: fake.fetch, sleep: noSleep });
    await publisher.publish(
      request({
        media: { kind: "slideshow", urls: ["https://t/1", "https://t/2", "https://t/3"] },
      }),
    );
    const posts = fake.to("POST", /\/th-user\/threads$/);
    expect(bodyOf(posts[0])).toMatchObject({
      media_type: "IMAGE",
      is_carousel_item: "true",
    });
    expect(bodyOf(posts[3])).toMatchObject({
      media_type: "CAROUSEL",
      children: "k1,k2,k3",
    });
  });

  it("más de 500 caracteres es bad_request antes de la red", async () => {
    const fake = new FakeFetch([]);
    const publisher = new ThreadsPublisher({ fetch: fake.fetch, sleep: noSleep });
    await expect(
      publisher.publish(request({ caption: "a".repeat(501) })),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
    expect(fake.calls).toHaveLength(0);
  });

  it("cuota (código 4) → rate_limited; token vencido (190) → unauthorized", async () => {
    const quota = new ThreadsPublisher({
      fetch: new FakeFetch(
        routes({
          container: {
            method: "POST",
            match: /\/th-user\/threads$/,
            replies: [{ status: 400, json: { error: { code: 4, message: "x" } } }],
          },
        }),
      ).fetch,
      sleep: noSleep,
    });
    await expect(quota.publish(request())).rejects.toMatchObject({
      code: "rate_limited",
    });

    const expired = new ThreadsPublisher({
      fetch: new FakeFetch(
        routes({
          container: {
            method: "POST",
            match: /\/th-user\/threads$/,
            replies: [{ status: 401, json: { error: { code: 190, message: "x" } } }],
          },
        }),
      ).fetch,
      sleep: noSleep,
    });
    await expect(expired.publish(request())).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("contenedor en ERROR (p. ej. FAILED_PROCESSING_VIDEO) → unsupported_media", async () => {
    const fake = new FakeFetch([
      { method: "POST", match: /\/th-user\/threads$/, replies: [{ json: { id: "c" } }] },
      {
        method: "GET",
        match: "/c?",
        replies: [
          { json: { status: "ERROR", error_message: "FAILED_PROCESSING_VIDEO" } },
        ],
      },
    ]);
    const publisher = new ThreadsPublisher({ fetch: fake.fetch, sleep: noSleep });
    const status = await publisher.publish(
      request({ media: { kind: "video", urls: ["https://t/v.mp4"] } }),
    );
    expect(status.failure?.reason).toBe("unsupported_media");
  });
});

describeSocialPublisherContract({ describe, it }, "threads (fetch falso)", {
  makeAdapter: () =>
    new ThreadsPublisher({
      fetch: new FakeFetch([
        {
          method: "GET",
          match: "id-que-no-existe",
          replies: [{ status: 400, json: { error: { code: 100, error_subcode: 33 } } }],
        },
      ]).fetch,
      sleep: noSleep,
    }),
  account: ACCOUNT,
});
