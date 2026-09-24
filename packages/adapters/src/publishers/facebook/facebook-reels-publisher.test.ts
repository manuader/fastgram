/**
 * Facebook Reels contra un `fetch` falso con las respuestas documentadas en
 * https://developers.facebook.com/docs/video-api/guides/reels-publishing:
 * `start` → `{"video_id","upload_url"}`; subida `{"success": true}`; estado
 * `{"status":{"video_status":…,"uploading_phase":{"status":…},…}}`; `finish`
 * → `{"success": true}`.
 */
import { describe, expect, it } from "vitest";
import {
  describeSocialPublisherContract,
  isPublishDeliveryUncertain,
  type PublishRequest,
} from "@fastgram/ports";

import { FakeFetch, bodyOf, noSleep, type Route } from "../__tests__/fake-fetch.js";
import { FacebookReelsPublisher, reelStateOf } from "./facebook-reels-publisher.js";

const ACCOUNT = {
  accountType: "oauth" as const,
  accountId: "conn-fb",
  accessToken: "page-token",
  platformUserId: "page-1",
};

const request = (over: Partial<PublishRequest> = {}): PublishRequest => ({
  account: ACCOUNT,
  media: { kind: "video", urls: ["https://tunnel.example/public-media/v"] },
  caption: "reel",
  idempotencyKey: `publish:${Math.random().toString(36).slice(2)}`,
  ...over,
});

const statusOf = (
  video_status: string,
  uploading: string,
  publishing = "not_started",
) => ({
  json: {
    status: {
      video_status,
      uploading_phase: { status: uploading },
      processing_phase: { status: "not_started" },
      publishing_phase: { status: publishing },
    },
  },
});

const routes = (over: { finish?: Route; status?: Route } = {}): Route[] => [
  {
    method: "POST",
    match: "/page-1/video_reels",
    replies: [
      {
        json: {
          video_id: "vid-1",
          upload_url: "https://rupload.facebook.com/video-upload/v26.0/vid-1",
        },
      },
      ...(over.finish === undefined ? [{ json: { success: true } }] : []),
    ],
  },
  ...(over.finish === undefined ? [] : [over.finish]),
  {
    method: "POST",
    match: "rupload.facebook.com",
    replies: [{ json: { success: true } }],
  },
  over.status ?? {
    method: "GET",
    match: "/vid-1?",
    replies: [
      statusOf("uploading", "in_progress"),
      statusOf("upload_complete", "complete"),
      statusOf("ready", "complete", "complete"),
    ],
  },
];

describe("Facebook Reels", () => {
  it("start → subida por file_url → estado → finish PUBLISHED", async () => {
    const fake = new FakeFetch(routes());
    const publisher = new FacebookReelsPublisher({ fetch: fake.fetch, sleep: noSleep });

    const status = await publisher.publish(request());

    expect(status).toEqual({ kind: "published", externalPostId: "vid-1" });
    const [start, finish] = fake.to("POST", "/page-1/video_reels");
    expect(bodyOf(start)).toEqual({ upload_phase: "start", access_token: "page-token" });
    expect(bodyOf(finish)).toEqual({
      upload_phase: "finish",
      video_id: "vid-1",
      video_state: "PUBLISHED",
      description: "reel",
      access_token: "page-token",
    });
    const upload = fake.to("POST", "rupload")[0];
    expect(upload?.url).toBe("https://rupload.facebook.com/video-upload/v26.0/vid-1");
    expect(upload?.headers["Authorization"]).toBe("OAuth page-token");
    expect(upload?.headers["file_url"]).toBe("https://tunnel.example/public-media/v");
  });

  it("sin publicar al final de la espera queda `processing` para el watcher", async () => {
    const fake = new FakeFetch(
      routes({
        status: {
          method: "GET",
          match: "/vid-1?",
          replies: [statusOf("processing", "complete", "in_progress")],
        },
      }),
    );
    const publisher = new FacebookReelsPublisher({
      fetch: fake.fetch,
      sleep: noSleep,
      pollIntervalMs: 1_000,
      publishWaitMs: 2_000,
    });
    expect(await publisher.publish(request())).toEqual({
      kind: "processing",
      externalPostId: "vid-1",
    });
  });

  it("5xx en finish = entrega incierta", async () => {
    const fake = new FakeFetch([
      {
        method: "POST",
        match: "/page-1/video_reels",
        replies: [{ json: { video_id: "vid-1" } }, { status: 500, json: {} }],
      },
      { method: "POST", match: "rupload", replies: [{ json: { success: true } }] },
      {
        method: "GET",
        match: "/vid-1?",
        replies: [statusOf("upload_complete", "complete")],
      },
    ]);
    const publisher = new FacebookReelsPublisher({ fetch: fake.fetch, sleep: noSleep });
    const error = await publisher.publish(request()).catch((e: unknown) => e);
    expect(isPublishDeliveryUncertain(error)).toBe(true);
  });

  it("token de página vencido → unauthorized; cuota (código 4) → rate_limited", async () => {
    const make = (reply: { status: number; json: unknown }) =>
      new FacebookReelsPublisher({
        fetch: new FakeFetch([
          { method: "POST", match: "/page-1/video_reels", replies: [reply] },
        ]).fetch,
        sleep: noSleep,
      });
    await expect(
      make({ status: 401, json: { error: { code: 190 } } }).publish(request()),
    ).rejects.toMatchObject({ code: "unauthorized" });
    await expect(
      make({ status: 400, json: { error: { code: 4 } } }).publish(request()),
    ).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("video rechazado en el procesamiento → unsupported_media", async () => {
    const fake = new FakeFetch(
      routes({
        status: {
          method: "GET",
          match: "/vid-1?",
          replies: [{ json: { status: { video_status: "error" } } }],
        },
      }),
    );
    const publisher = new FacebookReelsPublisher({ fetch: fake.fetch, sleep: noSleep });
    const status = await publisher.publish(request());
    expect(status.failure?.reason).toBe("unsupported_media");
  });

  it("sólo video: una imagen es bad_request", async () => {
    const publisher = new FacebookReelsPublisher({ fetch: new FakeFetch([]).fetch });
    await expect(
      publisher.publish(request({ media: { kind: "image", urls: ["https://t/i.jpg"] } })),
    ).rejects.toMatchObject({ code: "bad_request" });
  });

  it("lee el estado documentado", () => {
    expect(reelStateOf(statusOf("uploading", "in_progress").json).kind).toBe("uploading");
    expect(reelStateOf(statusOf("upload_complete", "complete").json).kind).toBe(
      "uploaded",
    );
    expect(reelStateOf(statusOf("ready", "complete", "complete").json).kind).toBe(
      "published",
    );
    expect(reelStateOf({ status: { video_status: "expired" } }).kind).toBe("expired");
  });
});

describeSocialPublisherContract({ describe, it }, "facebook reels (fetch falso)", {
  makeAdapter: () =>
    new FacebookReelsPublisher({
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
