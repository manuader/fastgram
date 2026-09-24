/**
 * X contra un `fetch` falso con las respuestas documentadas en
 * https://docs.x.com/x-api/media/quickstart/media-upload-chunked
 * (`initialize` → `{"data":{"id":"1880028106020515840","media_key":"13_1880028106020515840","expires_after_secs":86400}}`,
 * `finalize` → `processing_info`) y https://docs.x.com/x-api/posts/create-post
 * (`201 {"data":{"id","text"}}`).
 */
import { describe, expect, it } from "vitest";
import {
  describeSocialPublisherContract,
  isPublishDeliveryUncertain,
  type PublishRequest,
} from "@fastgram/ports";

import { FakeFetch, noSleep, type Route } from "../__tests__/fake-fetch.js";
import { XPublisher, stripLinks } from "./x-publisher.js";

const ACCOUNT = {
  accountType: "oauth" as const,
  accountId: "conn-x",
  accessToken: "x-tok",
};
const MEDIA_ID = "1880028106020515840";

const request = (over: Partial<PublishRequest> = {}): PublishRequest => ({
  account: ACCOUNT,
  media: { kind: "video", urls: ["http://minio.local/signed/v.mp4"] },
  caption: "mirá esto",
  idempotencyKey: `publish:${Math.random().toString(36).slice(2)}`,
  ...over,
});

const bytes = (n: number) => new Uint8Array(n).fill(7);

const routes = (
  over: { create?: Route; finalize?: Route; size?: number } = {},
): Route[] => [
  {
    method: "GET",
    match: "minio.local",
    replies: [
      { bytes: bytes(over.size ?? 10), headers: { "content-type": "video/mp4" } },
    ],
  },
  {
    method: "POST",
    match: "/2/media/upload/initialize",
    replies: [
      {
        json: {
          data: { id: MEDIA_ID, media_key: `13_${MEDIA_ID}`, expires_after_secs: 86400 },
        },
      },
    ],
  },
  { method: "POST", match: "/append", replies: [{ status: 204 }] },
  over.finalize ?? {
    method: "POST",
    match: "/finalize",
    replies: [
      {
        json: {
          data: {
            id: MEDIA_ID,
            media_key: `13_${MEDIA_ID}`,
            size: 10,
            expires_after_secs: 86400,
            processing_info: { state: "pending", check_after_secs: 1 },
          },
        },
      },
    ],
  },
  {
    method: "GET",
    match: "command=STATUS",
    replies: [
      {
        json: {
          data: { processing_info: { state: "in_progress", check_after_secs: 1 } },
        },
      },
      { json: { data: { processing_info: { state: "succeeded" } } } },
    ],
  },
  over.create ?? {
    method: "POST",
    match: "/2/tweets",
    replies: [{ status: 201, json: { data: { id: "post-1", text: "mirá esto" } } }],
  },
];

describe("X", () => {
  it("video: bajar → initialize → append → finalize → STATUS → create post", async () => {
    const fake = new FakeFetch(routes());
    const publisher = new XPublisher({ fetch: fake.fetch, sleep: noSleep });

    const status = await publisher.publish(request());

    expect(status).toEqual({ kind: "published", externalPostId: "post-1" });
    const init = fake.to("POST", "initialize")[0];
    expect(init?.url).toBe("https://api.x.com/2/media/upload/initialize");
    expect(JSON.parse(String(init?.body))).toEqual({
      media_type: "video/mp4",
      total_bytes: 10,
      media_category: "tweet_video",
    });
    const append = fake.to("POST", "/append")[0];
    expect(append?.url).toBe(`https://api.x.com/2/media/upload/${MEDIA_ID}/append`);
    expect(append?.body).toBeInstanceOf(FormData);
    expect((append?.body as FormData).get("segment_index")).toBe("0");
    expect(fake.to("GET", "command=STATUS")).toHaveLength(2);
    const create = fake.to("POST", "/2/tweets")[0];
    expect(create?.headers["Authorization"]).toBe("Bearer x-tok");
    expect(JSON.parse(String(create?.body))).toEqual({
      text: "mirá esto",
      media: { media_ids: [MEDIA_ID] },
    });
  });

  it("parte en trozos de ≤ 5 MB con segment_index creciente", async () => {
    const fake = new FakeFetch(routes({ size: 9 }));
    const publisher = new XPublisher({
      fetch: fake.fetch,
      sleep: noSleep,
      chunkBytes: 4,
    });
    await publisher.publish(request());
    const segments = fake
      .to("POST", "/append")
      .map((c) => (c.body as FormData).get("segment_index"));
    expect(segments).toEqual(["0", "1", "2"]);
  });

  it("sin links por defecto: los saca y deja la copy publicada", async () => {
    const fake = new FakeFetch(routes());
    const publisher = new XPublisher({ fetch: fake.fetch, sleep: noSleep });
    const status = await publisher.publish(
      request({
        media: { kind: "text", urls: [] },
        caption: "nuevo post https://ejemplo.com/a ya",
      }),
    );
    expect(JSON.parse(String(fake.to("POST", "/2/tweets")[0]?.body))).toEqual({
      text: "nuevo post ya",
    });
    expect(status.publishedCaption).toBe("nuevo post ya");
  });

  it("con allowLinks los deja", async () => {
    const fake = new FakeFetch(routes());
    const publisher = new XPublisher({
      fetch: fake.fetch,
      sleep: noSleep,
      allowLinks: true,
    });
    await publisher.publish(
      request({ media: { kind: "text", urls: [] }, caption: "ver https://ejemplo.com" }),
    );
    expect(JSON.parse(String(fake.to("POST", "/2/tweets")[0]?.body))).toEqual({
      text: "ver https://ejemplo.com",
    });
  });

  it("stripLinks saca http(s) y www, no toca dominios pelados", () => {
    expect(stripLinks("a http://x.y/z b www.foo.com c Node.js")).toBe("a b c Node.js");
  });

  it("429 → rate_limited reintentable; 401 → unauthorized", async () => {
    const limited = new XPublisher({
      fetch: new FakeFetch(
        routes({
          create: {
            method: "POST",
            match: "/2/tweets",
            replies: [{ status: 429, json: { title: "Too Many Requests" } }],
          },
        }),
      ).fetch,
      sleep: noSleep,
    });
    const error = await limited
      .publish(request({ media: { kind: "text", urls: [] } }))
      .catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "rate_limited", isRetryable: true });

    const expired = new XPublisher({
      fetch: new FakeFetch(
        routes({
          create: {
            method: "POST",
            match: "/2/tweets",
            replies: [{ status: 401, json: { title: "Unauthorized" } }],
          },
        }),
      ).fetch,
      sleep: noSleep,
    });
    await expect(
      expired.publish(request({ media: { kind: "text", urls: [] } })),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });

  it("media rechazada en el procesamiento → unsupported_media, sin crear el post", async () => {
    const fake = new FakeFetch(
      routes({
        finalize: {
          method: "POST",
          match: "/finalize",
          replies: [
            { json: { data: { id: MEDIA_ID, processing_info: { state: "failed" } } } },
          ],
        },
      }),
    );
    const publisher = new XPublisher({ fetch: fake.fetch, sleep: noSleep });
    const status = await publisher.publish(request());
    expect(status.failure?.reason).toBe("unsupported_media");
    expect(fake.to("POST", "/2/tweets")).toHaveLength(0);
  });

  it("5xx al crear el post = entrega incierta", async () => {
    const fake = new FakeFetch(
      routes({
        create: { method: "POST", match: "/2/tweets", replies: [{ status: 503 }] },
      }),
    );
    const publisher = new XPublisher({ fetch: fake.fetch, sleep: noSleep });
    const error = await publisher
      .publish(request({ media: { kind: "text", urls: [] } }))
      .catch((e: unknown) => e);
    expect(isPublishDeliveryUncertain(error)).toBe(true);
  });

  it("más de 4 fotos falla antes de subir nada", async () => {
    const fake = new FakeFetch([]);
    const publisher = new XPublisher({ fetch: fake.fetch, sleep: noSleep });
    const status = await publisher.publish(
      request({ media: { kind: "slideshow", urls: ["1", "2", "3", "4", "5"] } }),
    );
    expect(status.failure?.reason).toBe("unsupported_media");
    expect(fake.calls).toHaveLength(0);
  });

  it("getStatus: un post inexistente (200 con resource-not-found) es null", async () => {
    const publisher = new XPublisher({
      fetch: new FakeFetch([
        {
          method: "GET",
          match: "/2/tweets/nope",
          replies: [
            {
              json: {
                errors: [
                  {
                    type: "https://api.x.com/2/problems/resource-not-found",
                    title: "Not Found Error",
                    resource_type: "tweet",
                    resource_id: "nope",
                  },
                ],
              },
            },
          ],
        },
      ]).fetch,
    });
    expect(
      await publisher.getStatus({ account: ACCOUNT, externalPostId: "nope" }),
    ).toBeNull();
  });
});

describeSocialPublisherContract({ describe, it }, "x (fetch falso)", {
  makeAdapter: () =>
    new XPublisher({
      fetch: new FakeFetch([
        {
          method: "GET",
          match: "id-que-no-existe",
          replies: [
            {
              json: {
                errors: [{ type: "https://api.x.com/2/problems/resource-not-found" }],
              },
            },
          ],
        },
      ]).fetch,
      sleep: noSleep,
    }),
  account: ACCOUNT,
});
