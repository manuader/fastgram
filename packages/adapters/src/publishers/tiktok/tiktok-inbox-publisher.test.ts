/**
 * TikTok (Upload → inbox) contra un `fetch` falso con las respuestas
 * documentadas en:
 *  - https://developers.tiktok.com/doc/content-posting-api-reference-upload-video
 *    (`data.publish_id`, `data.upload_url`, `error.code`)
 *  - https://developers.tiktok.com/doc/content-posting-api-media-transfer-guide
 *    (206 por trozo intermedio, 201 al completar)
 *  - https://developers.tiktok.com/doc/content-posting-api-reference-get-video-status
 *    (ejemplo `{"data":{"status":"FAILED","fail_reason":"picture_size_check_failed",
 *    "publicaly_available_post_id":[],"uploaded_bytes":10000},"error":{"code":"ok",
 *    "message":"","log_id":"202210112248442CB9319E1FB30C1073F3"}}`)
 *  - https://developers.tiktok.com/doc/content-posting-api-reference-photo-post
 */
import { describe, expect, it } from "vitest";
import {
  PortError,
  describeSocialPublisherContract,
  isPublishDeliveryUncertain,
  type PublishRequest,
} from "@fastgram/ports";

import { FakeFetch, noSleep, type Route } from "../__tests__/fake-fetch.js";
import { TikTokInboxPublisher, planChunks } from "./tiktok-inbox-publisher.js";

const ACCOUNT = {
  accountType: "oauth" as const,
  accountId: "conn-tt",
  accessToken: "act.x",
};
const MB = 1024 * 1024;
const OK = { code: "ok", message: "", log_id: "202210112248442CB9319E1FB30C1073F3" };

const request = (over: Partial<PublishRequest> = {}): PublishRequest => ({
  account: ACCOUNT,
  media: { kind: "video", urls: ["http://minio.local/signed/v.mp4"] },
  caption: "",
  postingMode: "inbox",
  idempotencyKey: `publish:${Math.random().toString(36).slice(2)}`,
  ...over,
});

const statusReply = (status: string, fail_reason?: string) => ({
  json: {
    data: {
      status,
      ...(fail_reason === undefined ? {} : { fail_reason }),
      publicaly_available_post_id: [],
      uploaded_bytes: 10000,
    },
    error: OK,
  },
});

const routes = (
  over: { size?: number; put?: Route; status?: Route; init?: Route } = {},
): Route[] => [
  {
    method: "GET",
    match: "minio.local",
    replies: [
      {
        bytes: new Uint8Array(over.size ?? 1000),
        headers: { "content-type": "video/mp4" },
      },
    ],
  },
  over.init ?? {
    method: "POST",
    match: "/v2/post/publish/inbox/video/init/",
    replies: [
      {
        json: {
          data: {
            publish_id: "v_inbox_file~v2.123456789",
            upload_url:
              "https://open-upload.tiktokapis.com/video/?upload_id=67890&upload_token=Xza123",
          },
          error: OK,
        },
      },
    ],
  },
  over.put ?? {
    method: "PUT",
    match: "open-upload.tiktokapis.com",
    replies: [{ status: 201 }],
  },
  over.status ?? {
    method: "POST",
    match: "/v2/post/publish/status/fetch/",
    replies: [statusReply("PROCESSING_UPLOAD"), statusReply("SEND_TO_USER_INBOX")],
  },
];

describe("TikTok · Upload al inbox (D-10)", () => {
  it("video chico: un solo trozo, FILE_UPLOAD, y termina IN_USER_INBOX", async () => {
    const fake = new FakeFetch(routes());
    const publisher = new TikTokInboxPublisher({ fetch: fake.fetch, sleep: noSleep });

    const status = await publisher.publish(request());

    expect(status).toEqual({
      kind: "in_user_inbox",
      externalPostId: "v_inbox_file~v2.123456789",
    });
    const init = fake.to("POST", "inbox/video/init")[0];
    expect(init?.url).toBe(
      "https://open.tiktokapis.com/v2/post/publish/inbox/video/init/",
    );
    expect(init?.headers["Authorization"]).toBe("Bearer act.x");
    expect(init?.headers["Content-Type"]).toBe("application/json; charset=UTF-8");
    expect(JSON.parse(String(init?.body))).toEqual({
      source_info: {
        source: "FILE_UPLOAD",
        video_size: 1000,
        chunk_size: 1000,
        total_chunk_count: 1,
      },
    });
    const put = fake.to("PUT", "open-upload")[0];
    expect(put?.headers["Content-Range"]).toBe("bytes 0-999/1000");
    expect(put?.headers["Content-Type"]).toBe("video/mp4");
    // El token NO viaja a la URL de subida.
    expect(put?.headers["Authorization"]).toBeUndefined();
  });

  it("planChunks sigue la guía: <5 MB entero; si no, floor(size/chunk) y el último se lleva el resto", () => {
    expect(planChunks(3 * MB, 10 * MB)).toEqual({ chunkSize: 3 * MB, count: 1 });
    expect(planChunks(25 * MB, 10 * MB)).toEqual({ chunkSize: 10 * MB, count: 2 });
    expect(planChunks(25 * MB, 1 * MB)).toEqual({ chunkSize: 5 * MB, count: 5 });
  });

  it("video grande: trozos secuenciales con Content-Range, 206 y 201", async () => {
    const size = 12 * MB;
    const fake = new FakeFetch(
      routes({
        size,
        put: {
          method: "PUT",
          match: "open-upload",
          replies: [{ status: 206 }, { status: 201 }],
        },
      }),
    );
    const publisher = new TikTokInboxPublisher({
      fetch: fake.fetch,
      sleep: noSleep,
      chunkBytes: 5 * MB,
    });
    await publisher.publish(request());
    const ranges = fake.to("PUT", "open-upload").map((c) => c.headers["Content-Range"]);
    // 12 MB / 5 MB = 2 trozos; el segundo lleva 7 MB.
    expect(ranges).toEqual([
      `bytes 0-${String(5 * MB - 1)}/${String(size)}`,
      `bytes ${String(5 * MB)}-${String(size - 1)}/${String(size)}`,
    ]);
  });

  it("fotos: content/init con PULL_FROM_URL y MEDIA_UPLOAD, sin privacy_level", async () => {
    const fake = new FakeFetch([
      {
        method: "POST",
        match: "/v2/post/publish/content/init/",
        replies: [
          { json: { data: { publish_id: "p_pub_url~v2.123456789" }, error: OK } },
        ],
      },
      {
        method: "POST",
        match: "status/fetch",
        replies: [statusReply("SEND_TO_USER_INBOX")],
      },
    ]);
    const publisher = new TikTokInboxPublisher({ fetch: fake.fetch, sleep: noSleep });
    const status = await publisher.publish(
      request({
        media: {
          kind: "slideshow",
          urls: ["https://media.example/1.jpg", "https://media.example/2.jpg"],
        },
        caption: "funny cat",
        description: "#fyp",
      }),
    );
    expect(status.kind).toBe("in_user_inbox");
    expect(JSON.parse(String(fake.to("POST", "content/init")[0]?.body))).toEqual({
      post_info: { title: "funny cat", description: "#fyp" },
      source_info: {
        source: "PULL_FROM_URL",
        photo_images: ["https://media.example/1.jpg", "https://media.example/2.jpg"],
        photo_cover_index: 0,
      },
      post_mode: "MEDIA_UPLOAD",
      media_type: "PHOTO",
    });
  });

  it("si sigue procesando, devuelve `processing` con el publish_id para el watcher", async () => {
    const fake = new FakeFetch(
      routes({
        status: {
          method: "POST",
          match: "status/fetch",
          replies: [statusReply("PROCESSING_UPLOAD")],
        },
      }),
    );
    const publisher = new TikTokInboxPublisher({
      fetch: fake.fetch,
      sleep: noSleep,
      pollIntervalMs: 1_000,
      statusWaitMs: 2_000,
    });
    expect(await publisher.publish(request())).toEqual({
      kind: "processing",
      externalPostId: "v_inbox_file~v2.123456789",
    });
  });

  it("direct está prohibido (D-10)", async () => {
    const publisher = new TikTokInboxPublisher({ fetch: new FakeFetch([]).fetch });
    await expect(
      publisher.publish(request({ postingMode: "direct" })),
    ).rejects.toMatchObject({
      code: "bad_request",
    });
  });
});

describe("TikTok · errores", () => {
  const initError = (status: number, code: string): Route => ({
    method: "POST",
    match: "inbox/video/init",
    replies: [{ status, json: { error: { code, message: "crudo", log_id: "x" } } }],
  });

  it("token vencido (401 access_token_invalid) → unauthorized", async () => {
    const publisher = new TikTokInboxPublisher({
      fetch: new FakeFetch(routes({ init: initError(401, "access_token_invalid") }))
        .fetch,
      sleep: noSleep,
    });
    await expect(publisher.publish(request())).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("cuota (spam_risk_too_many_pending_share) → post_limit_exceeded", async () => {
    const publisher = new TikTokInboxPublisher({
      fetch: new FakeFetch(
        routes({ init: initError(403, "spam_risk_too_many_pending_share") }),
      ).fetch,
      sleep: noSleep,
    });
    const status = await publisher.publish(request());
    expect(status.failure?.reason).toBe("post_limit_exceeded");
    expect(JSON.stringify(status)).not.toContain("crudo");
  });

  it("rate_limit_exceeded (429) → rate_limited reintentable", async () => {
    const publisher = new TikTokInboxPublisher({
      fetch: new FakeFetch(routes({ init: initError(429, "rate_limit_exceeded") })).fetch,
      sleep: noSleep,
    });
    const error = await publisher.publish(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortError);
    expect((error as PortError).isRetryable).toBe(true);
  });

  it("media rechazada (fail_reason file_format_check_failed) → unsupported_media", async () => {
    const publisher = new TikTokInboxPublisher({
      fetch: new FakeFetch(
        routes({
          status: {
            method: "POST",
            match: "status/fetch",
            replies: [statusReply("FAILED", "file_format_check_failed")],
          },
        }),
      ).fetch,
      sleep: noSleep,
    });
    const status = await publisher.publish(request());
    expect(status.kind).toBe("failed");
    expect(status.failure?.reason).toBe("unsupported_media");
  });

  it("fail_reason internal (reintentable según la doc) → PortError reintentable", async () => {
    const publisher = new TikTokInboxPublisher({
      fetch: new FakeFetch(
        routes({
          status: {
            method: "POST",
            match: "status/fetch",
            replies: [statusReply("FAILED", "internal")],
          },
        }),
      ).fetch,
      sleep: noSleep,
    });
    const error = await publisher.publish(request()).catch((e: unknown) => e);
    expect((error as PortError).isRetryable).toBe(true);
  });

  it("5xx en el último trozo = entrega incierta", async () => {
    const publisher = new TikTokInboxPublisher({
      fetch: new FakeFetch(
        routes({
          put: { method: "PUT", match: "open-upload", replies: [{ status: 502 }] },
        }),
      ).fetch,
      sleep: noSleep,
    });
    const error = await publisher.publish(request()).catch((e: unknown) => e);
    expect(isPublishDeliveryUncertain(error)).toBe(true);
  });
});

describe("TikTok · getStatus para el watcher", () => {
  const make = (reply: Route["replies"][number]) =>
    new TikTokInboxPublisher({
      fetch: new FakeFetch([{ method: "POST", match: "status/fetch", replies: [reply] }])
        .fetch,
    });

  it("PUBLISH_COMPLETE (el creador tocó Post) → published", async () => {
    expect(
      await make(statusReply("PUBLISH_COMPLETE")).getStatus({
        account: ACCOUNT,
        externalPostId: "p1",
      }),
    ).toEqual({ kind: "published", externalPostId: "p1" });
  });

  it("invalid_publish_id → null", async () => {
    expect(
      await make({
        status: 400,
        json: { error: { code: "invalid_publish_id" } },
      }).getStatus({
        account: ACCOUNT,
        externalPostId: "id-que-no-existe",
      }),
    ).toBeNull();
  });
});

describeSocialPublisherContract({ describe, it }, "tiktok inbox (fetch falso)", {
  makeAdapter: () =>
    new TikTokInboxPublisher({
      fetch: new FakeFetch([
        {
          method: "POST",
          match: "status/fetch",
          replies: [{ status: 400, json: { error: { code: "invalid_publish_id" } } }],
        },
      ]).fetch,
      sleep: noSleep,
    }),
  account: ACCOUNT,
});
