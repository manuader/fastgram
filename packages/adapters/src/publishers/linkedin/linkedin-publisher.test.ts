/**
 * LinkedIn contra un `fetch` falso con las respuestas documentadas en la
 * Posts API (`201` + `x-restli-id`), la Videos API (`initializeUpload` →
 * `value.{video, uploadToken, uploadInstructions[]}`, `PUT` → `etag`,
 * `finalizeUpload` → `200`, `GET` → `status`) y la Images API
 * (`initializeUpload` → `value.{uploadUrl, image}`). URLs en la cabecera de
 * `linkedin-publisher.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  describeSocialPublisherContract,
  isPortError,
  isPublishDeliveryUncertain,
  type PublishRequest,
} from "@fastgram/ports";

import { FakeFetch, bodyOf, noSleep, type Route } from "../__tests__/fake-fetch.js";
import { LinkedInPublisher, escapeLittleText } from "./linkedin-publisher.js";

const PERSON = "urn:li:person:782bbtaQ";
const ORG = "urn:li:organization:2414183";
const ACCOUNT = {
  accountType: "oauth" as const,
  accountId: "conn-li",
  accessToken: "AQV-tok",
  platformUserId: PERSON,
};
const VIDEO = "urn:li:video:C5505AQH-oV1qvnFtKA";
const POST_ID = "urn:li:share:6844785523593134080";

const request = (over: Partial<PublishRequest> = {}): PublishRequest => ({
  account: ACCOUNT,
  media: { kind: "video", urls: ["http://minio.local/signed/v.mp4"] },
  caption: "Hola #marca (nuevo) @todos",
  idempotencyKey: `publish:${Math.random().toString(36).slice(2)}`,
  ...over,
});

const videoBytes = new Uint8Array(100 * 1024).fill(3);
const PART = 64 * 1024;

const videoRoutes = (over: { video?: Route; create?: Route } = {}): Route[] => [
  {
    method: "GET",
    match: "minio.local",
    replies: [{ bytes: videoBytes, headers: { "content-type": "video/mp4" } }],
  },
  {
    method: "POST",
    match: "/rest/videos?action=initializeUpload",
    replies: [
      {
        json: {
          value: {
            uploadUrlsExpireAt: 1633234498985,
            video: VIDEO,
            uploadInstructions: [
              {
                uploadUrl: "https://www.linkedin.com/dms-uploads/p1",
                firstByte: 0,
                lastByte: PART - 1,
              },
              {
                uploadUrl: "https://www.linkedin.com/dms-uploads/p2",
                firstByte: PART,
                lastByte: videoBytes.byteLength - 1,
              },
            ],
            uploadToken: "",
          },
        },
      },
    ],
  },
  {
    method: "PUT",
    match: "dms-uploads/p1",
    replies: [{ status: 200, headers: { etag: "etag-1" } }],
  },
  {
    method: "PUT",
    match: "dms-uploads/p2",
    replies: [{ status: 200, headers: { etag: "etag-2" } }],
  },
  {
    method: "POST",
    match: "/rest/videos?action=finalizeUpload",
    replies: [{ status: 200 }],
  },
  over.video ?? {
    method: "GET",
    match: "/rest/videos/",
    replies: [
      { json: { id: VIDEO, status: "PROCESSING" } },
      { json: { id: VIDEO, status: "AVAILABLE" } },
    ],
  },
  over.create ?? {
    method: "POST",
    match: "/rest/posts",
    replies: [{ status: 201, headers: { "x-restli-id": POST_ID } }],
  },
];

const make = (r: Route[]) => {
  const fake = new FakeFetch(r);
  return {
    fake,
    publisher: new LinkedInPublisher({
      fetch: fake.fetch,
      sleep: noSleep,
      pollIntervalMs: 1,
    }),
  };
};

describe("linkedin · video", () => {
  it("initialize → PUT de cada parte sin token → finalize con los ETags → post", async () => {
    const { fake, publisher } = make(videoRoutes());
    const status = await publisher.publish(request());
    expect(status).toEqual({
      kind: "published",
      externalPostId: POST_ID,
      permalink: `https://www.linkedin.com/feed/update/${POST_ID}/`,
    });

    const [init] = fake.to("POST", "action=initializeUpload");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer AQV-tok",
      "LinkedIn-Version": "202609",
      "X-Restli-Protocol-Version": "2.0.0",
    });
    expect(bodyOf(init)).toEqual({
      initializeUploadRequest: {
        owner: PERSON,
        fileSizeBytes: videoBytes.byteLength,
        uploadCaptions: false,
        uploadThumbnail: false,
      },
    });
    const [p1] = fake.to("PUT", "dms-uploads/p1");
    expect(p1?.headers["Authorization"]).toBeUndefined();
    expect((p1?.body as Uint8Array).byteLength).toBe(PART);
    expect(bodyOf(fake.to("POST", "action=finalizeUpload")[0])).toEqual({
      finalizeUploadRequest: {
        video: VIDEO,
        uploadToken: "",
        uploadedPartIds: ["etag-1", "etag-2"],
      },
    });
    expect(bodyOf(fake.to("POST", "/rest/posts")[0])).toEqual({
      author: PERSON,
      commentary: "Hola \\#marca \\(nuevo\\) \\@todos",
      visibility: "PUBLIC",
      distribution: {
        feedDistribution: "MAIN_FEED",
        targetEntities: [],
        thirdPartyDistributionChannels: [],
      },
      content: { media: { id: VIDEO } },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    });
  });

  it("como Página: el autor es el URN de la organización", async () => {
    const { fake, publisher } = make(videoRoutes());
    await publisher.publish(request({ account: { ...ACCOUNT, platformUserId: ORG } }));
    expect(bodyOf(fake.to("POST", "/rest/posts")[0])).toMatchObject({ author: ORG });
    expect(bodyOf(fake.to("POST", "action=initializeUpload")[0])).toMatchObject({
      initializeUploadRequest: { owner: ORG },
    });
  });

  it("PROCESSING_FAILED: falla con unsupported_media y no crea el post", async () => {
    const { fake, publisher } = make(
      videoRoutes({
        video: {
          method: "GET",
          match: "/rest/videos/",
          replies: [
            {
              json: {
                id: VIDEO,
                status: "PROCESSING_FAILED",
                processingFailureReason: "x",
              },
            },
          ],
        },
      }),
    );
    const status = await publisher.publish(request());
    expect(status).toMatchObject({
      kind: "failed",
      failure: { reason: "unsupported_media" },
    });
    expect(fake.to("POST", "/rest/posts")).toHaveLength(0);
  });

  it("video de menos de 3 s (dato del render): falla sin bajar nada", async () => {
    const { fake, publisher } = make(videoRoutes());
    const status = await publisher.publish(
      request({
        media: { kind: "video", urls: ["http://minio.local/v.mp4"], durationSeconds: 2 },
      }),
    );
    expect(status.failure?.reason).toBe("unsupported_media");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("linkedin · imágenes", () => {
  const imageRoutes = (n: number): Route[] => [
    {
      method: "GET",
      match: "minio.local",
      replies: [
        { bytes: new Uint8Array(10).fill(1), headers: { "content-type": "image/png" } },
      ],
    },
    {
      method: "POST",
      match: "/rest/images?action=initializeUpload",
      replies: Array.from({ length: n }, (_, i) => ({
        json: {
          value: {
            uploadUrlExpiresAt: 1650567510704,
            uploadUrl: `https://www.linkedin.com/dms-uploads/img-${String(i)}`,
            image: `urn:li:image:C4E10AQF${String(i)}`,
          },
        },
      })),
    },
    { method: "PUT", match: "dms-uploads/img-", replies: [{ status: 201 }] },
    // Con sólo `w_member_social` el GET de la imagen es 403: se sigue igual.
    {
      method: "GET",
      match: "/rest/images/",
      replies: [{ status: 403, json: { status: 403 } }],
    },
    {
      method: "POST",
      match: "/rest/posts",
      replies: [{ status: 201, headers: { "x-restli-id": POST_ID } }],
    },
  ];

  it("una imagen: content.media; el PUT lleva el token", async () => {
    const { fake, publisher } = make(imageRoutes(1));
    const status = await publisher.publish(
      request({ media: { kind: "image", urls: ["http://minio.local/a.png"] } }),
    );
    expect(status.kind).toBe("published");
    expect(fake.to("PUT", "dms-uploads/img-0")[0]?.headers["Authorization"]).toBe(
      "Bearer AQV-tok",
    );
    expect(bodyOf(fake.to("POST", "/rest/posts")[0])).toMatchObject({
      content: { media: { id: "urn:li:image:C4E10AQF0" } },
    });
  });

  it("slideshow de tres: multiImage (el carrusel orgánico no existe)", async () => {
    const { fake, publisher } = make(imageRoutes(3));
    await publisher.publish(
      request({
        media: {
          kind: "slideshow",
          urls: [
            "http://minio.local/1.png",
            "http://minio.local/2.png",
            "http://minio.local/3.png",
          ],
        },
      }),
    );
    expect(bodyOf(fake.to("POST", "/rest/posts")[0])).toMatchObject({
      content: {
        multiImage: {
          images: [
            { id: "urn:li:image:C4E10AQF0" },
            { id: "urn:li:image:C4E10AQF1" },
            { id: "urn:li:image:C4E10AQF2" },
          ],
        },
      },
    });
  });

  it("más de 20 imágenes: falla sin subir", async () => {
    const { fake, publisher } = make(imageRoutes(1));
    const status = await publisher.publish(
      request({
        media: {
          kind: "carousel",
          urls: Array.from(
            { length: 21 },
            (_, i) => `http://minio.local/${String(i)}.png`,
          ),
        },
      }),
    );
    expect(status.failure?.reason).toBe("unsupported_media");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("linkedin · errores", () => {
  it("token vencido (401) al iniciar la subida → unauthorized", async () => {
    const r = videoRoutes();
    r[1] = {
      method: "POST",
      match: "/rest/videos?action=initializeUpload",
      replies: [{ status: 401, json: { status: 401, code: "EMPTY_ACCESS_TOKEN" } }],
    };
    const error: unknown = await make(r)
      .publisher.publish(request())
      .catch((e: unknown) => e);
    expect(isPortError(error) && error.code).toBe("unauthorized");
  });

  it("429 → rate_limited reintentable (nada llegó)", async () => {
    const r = videoRoutes();
    r[1] = {
      method: "POST",
      match: "/rest/videos?action=initializeUpload",
      replies: [{ status: 429, headers: { "retry-after": "60" } }],
    };
    const error: unknown = await make(r)
      .publisher.publish(request())
      .catch((e: unknown) => e);
    expect(isPortError(error) && error.code).toBe("rate_limited");
    expect(isPortError(error) && error.isRetryable).toBe(true);
  });

  it("403 al crear el post: permissions_missing", async () => {
    const { publisher } = make(
      videoRoutes({
        create: {
          method: "POST",
          match: "/rest/posts",
          replies: [{ status: 403, json: { code: "ACCESS_DENIED" } }],
        },
      }),
    );
    expect(await publisher.publish(request())).toMatchObject({
      kind: "failed",
      failure: { reason: "permissions_missing" },
    });
  });

  it("5xx al crear el post: entrega incierta", async () => {
    const { publisher } = make(
      videoRoutes({
        create: { method: "POST", match: "/rest/posts", replies: [{ status: 503 }] },
      }),
    );
    const error: unknown = await publisher.publish(request()).catch((e: unknown) => e);
    expect(isPublishDeliveryUncertain(error)).toBe(true);
  });

  it("commentary de más de 3000: bad_request antes de llamar", async () => {
    const { fake, publisher } = make(videoRoutes());
    const error: unknown = await publisher
      .publish(request({ caption: "a".repeat(3001) }))
      .catch((e: unknown) => e);
    expect(isPortError(error) && error.code).toBe("bad_request");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("little text", () => {
  it("escapa los reservados de la doc", () => {
    expect(escapeLittleText("|{}@[]()<>#\\*_~ ok")).toBe(
      "\\|\\{\\}\\@\\[\\]\\(\\)\\<\\>\\#\\\\\\*\\_\\~ ok",
    );
  });
});

describeSocialPublisherContract({ describe, it }, "linkedin (fetch falso)", {
  makeAdapter: () =>
    new LinkedInPublisher({
      fetch: new FakeFetch([
        {
          method: "GET",
          match: "id-que-no-existe",
          replies: [{ status: 404, json: { status: 404 } }],
        },
      ]).fetch,
      sleep: noSleep,
    }),
  account: ACCOUNT,
});
