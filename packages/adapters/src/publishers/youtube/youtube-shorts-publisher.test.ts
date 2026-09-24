/**
 * YouTube Shorts contra un `fetch` falso con las respuestas documentadas en
 * https://developers.google.com/youtube/v3/guides/using_resumable_upload_protocol
 * (paso 1 → `200` + `Location`; paso 2 → `201` con el recurso del video;
 * `308` + `Range` para reanudar) y los errores de
 * https://developers.google.com/youtube/v3/docs/errors (`quotaExceeded` 403,
 * `uploadLimitExceeded` 400, forma `{"error":{"code","errors":[{"reason"}]}}`).
 */
import { describe, expect, it } from "vitest";
import {
  describeSocialPublisherContract,
  isPortError,
  isPublishDeliveryUncertain,
  type PublishRequest,
} from "@fastgram/ports";

import { FakeFetch, bodyOf, type Route } from "../__tests__/fake-fetch.js";
import { mp4Fixture } from "../__tests__/mp4-fixture.js";
import { probeMp4 } from "./mp4-probe.js";
import { YouTubeShortsPublisher, nextOffset } from "./youtube-shorts-publisher.js";

const ACCOUNT = {
  accountType: "oauth" as const,
  accountId: "conn-yt",
  accessToken: "ya29-tok",
  platformUserId: "UC_x5XG1OV2P6uZZ5FSM9Ttw",
};
const SESSION =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&upload_id=xa298sd_f";
const VIDEO_ID = "dQw4w9WgXcQ";

const vertical = mp4Fixture({ seconds: 42, width: 1080, height: 1920 });

const request = (over: Partial<PublishRequest> = {}): PublishRequest => ({
  account: ACCOUNT,
  media: { kind: "video", urls: ["http://minio.local/signed/v.mp4"] },
  caption: "Mirá esto",
  idempotencyKey: `publish:${Math.random().toString(36).slice(2)}`,
  ...over,
});

const ytError = (status: number, reason: string) => ({
  status,
  json: {
    error: { code: status, message: "…", errors: [{ domain: "youtube.quota", reason }] },
  },
});

const routes = (
  over: { file?: Uint8Array; init?: Route; upload?: Route } = {},
): Route[] => [
  {
    method: "GET",
    match: "minio.local",
    replies: [{ bytes: over.file ?? vertical, headers: { "content-type": "video/mp4" } }],
  },
  over.init ?? {
    method: "POST",
    match: "/upload/youtube/v3/videos?uploadType=resumable",
    replies: [{ status: 200, headers: { location: SESSION } }],
  },
  over.upload ?? {
    method: "PUT",
    match: "upload_id=xa298sd_f",
    replies: [
      {
        status: 201,
        json: {
          kind: "youtube#video",
          id: VIDEO_ID,
          status: { uploadStatus: "uploaded" },
        },
      },
    ],
  },
];

const make = (r: Route[], config: Record<string, unknown> = {}) => {
  const fake = new FakeFetch(r);
  return {
    fake,
    publisher: new YouTubeShortsPublisher({ fetch: fake.fetch, ...config }),
  };
};

describe("youtube · camino feliz", () => {
  it("abre la sesión resumable con snippet/status y sube los bytes; queda procesando", async () => {
    const { fake, publisher } = make(routes());
    const status = await publisher.publish(
      request({ description: "cuerpo", aiGenerated: true }),
    );
    expect(status).toEqual({ kind: "processing", externalPostId: VIDEO_ID });

    const [init] = fake.to("POST", "uploadType=resumable");
    expect(init?.url).toBe(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
    );
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer ya29-tok",
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Length": String(vertical.byteLength),
      "X-Upload-Content-Type": "video/mp4",
    });
    expect(bodyOf(init)).toEqual({
      snippet: { title: "Mirá esto", description: "cuerpo" },
      status: { privacyStatus: "public", containsSyntheticMedia: true },
    });
    const [put] = fake.to("PUT", "upload_id=");
    expect((put?.body as Uint8Array).byteLength).toBe(vertical.byteLength);
  });

  it("la privacidad es configurable", async () => {
    const { fake, publisher } = make(routes(), { privacyStatus: "unlisted" });
    await publisher.publish(request());
    expect(bodyOf(fake.to("POST", "uploadType=resumable")[0])).toMatchObject({
      status: { privacyStatus: "unlisted" },
    });
  });

  it("`<` y `>` se sacan del título y lo publicado queda en publishedCaption", async () => {
    const { publisher } = make(routes());
    const status = await publisher.publish(request({ caption: "a <b> c" }));
    expect(status.publishedCaption).toBe("a b c");
  });

  it("308 Resume Incomplete: sigue desde el byte siguiente a Range con Content-Range", async () => {
    const { fake, publisher } = make(
      routes({
        upload: {
          method: "PUT",
          match: "upload_id=xa298sd_f",
          replies: [
            { status: 308, headers: { range: "bytes=0-99" } },
            { status: 201, json: { id: VIDEO_ID } },
          ],
        },
      }),
    );
    const status = await publisher.publish(request());
    expect(status.externalPostId).toBe(VIDEO_ID);
    const puts = fake.to("PUT", "upload_id=");
    expect(puts[1]?.headers["Content-Range"]).toBe(
      `bytes 100-${String(vertical.byteLength - 1)}/${String(vertical.byteLength)}`,
    );
    expect((puts[1]?.body as Uint8Array).byteLength).toBe(vertical.byteLength - 100);
    expect(nextOffset(null)).toBe(0);
  });

  it("5xx al subir: pregunta el estado y, si ya está, no vuelve a subir", async () => {
    const { fake, publisher } = make(
      routes({
        upload: {
          method: "PUT",
          match: "upload_id=xa298sd_f",
          replies: [{ status: 503 }, { status: 200, json: { id: VIDEO_ID } }],
        },
      }),
    );
    const status = await publisher.publish(request());
    expect(status.externalPostId).toBe(VIDEO_ID);
    const puts = fake.to("PUT", "upload_id=");
    expect(puts).toHaveLength(2);
    expect(puts[1]?.headers["Content-Range"]).toBe(
      `bytes */${String(vertical.byteLength)}`,
    );
  });

  it("5xx al subir y 5xx al preguntar: entrega incierta, no se reintenta solo", async () => {
    const { publisher } = make(
      routes({
        upload: {
          method: "PUT",
          match: "upload_id=xa298sd_f",
          replies: [{ status: 503 }],
        },
      }),
    );
    const error: unknown = await publisher.publish(request()).catch((e: unknown) => e);
    expect(isPublishDeliveryUncertain(error)).toBe(true);
  });
});

describe("youtube · cuota y token", () => {
  it("quotaExceeded (403) al abrir la sesión: falla con post_limit_exceeded sin subir", async () => {
    const { fake, publisher } = make(
      routes({
        init: {
          method: "POST",
          match: "uploadType=resumable",
          replies: [ytError(403, "quotaExceeded")],
        },
      }),
    );
    const status = await publisher.publish(request());
    expect(status).toMatchObject({
      kind: "failed",
      failure: { reason: "post_limit_exceeded" },
    });
    expect(fake.to("PUT", "upload_id=")).toHaveLength(0);
  });

  it("uploadLimitExceeded (400): el tope diario del canal", async () => {
    const { publisher } = make(
      routes({
        init: {
          method: "POST",
          match: "uploadType=resumable",
          replies: [ytError(400, "uploadLimitExceeded")],
        },
      }),
    );
    expect(await publisher.publish(request())).toMatchObject({
      kind: "failed",
      failure: { reason: "post_limit_exceeded" },
    });
  });

  it("token vencido (401): unauthorized → AWAITING_RECONNECT en el worker", async () => {
    const { publisher } = make(
      routes({
        init: {
          method: "POST",
          match: "uploadType=resumable",
          replies: [ytError(401, "authError")],
        },
      }),
    );
    const error: unknown = await publisher.publish(request()).catch((e: unknown) => e);
    expect(isPortError(error) && error.code).toBe("unauthorized");
  });

  it("sin token no llama a nada", async () => {
    const { fake, publisher } = make(routes());
    const error: unknown = await publisher
      .publish(request({ account: { accountType: "oauth", accountId: "c" } }))
      .catch((e: unknown) => e);
    expect(isPortError(error) && error.code).toBe("unauthorized");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("youtube · validación de Short antes de subir", () => {
  it("horizontal: falla sin abrir sesión (no gasta cuota)", async () => {
    const { fake, publisher } = make(
      routes({ file: mp4Fixture({ seconds: 20, width: 1920, height: 1080 }) }),
    );
    const status = await publisher.publish(request());
    expect(status).toMatchObject({
      kind: "failed",
      failure: { reason: "unsupported_media" },
    });
    expect(status.failure?.message).toContain("vertical or square");
    expect(fake.to("POST", "uploadType=resumable")).toHaveLength(0);
  });

  it("más de 3 minutos: falla sin abrir sesión", async () => {
    const { fake, publisher } = make(
      routes({ file: mp4Fixture({ seconds: 181, width: 1080, height: 1920 }) }),
    );
    const status = await publisher.publish(request());
    expect(status.failure?.message).toContain("3 minutes");
    expect(fake.to("POST", "uploadType=resumable")).toHaveLength(0);
  });

  it("los datos del render ganan sobre el archivo", async () => {
    // El archivo dice vertical, pero el render dice 16:9: manda el render.
    const { publisher } = make(routes());
    const status = await publisher.publish(
      request({
        media: {
          kind: "video",
          urls: ["http://minio.local/signed/v.mp4"],
          width: 1920,
          height: 1080,
          durationSeconds: 30,
        },
      }),
    );
    expect(status.kind).toBe("failed");
  });

  it("cuadrado y exactamente 180 s es un Short", async () => {
    const { publisher } = make(
      routes({ file: mp4Fixture({ seconds: 180, width: 1080, height: 1080 }) }),
    );
    expect((await publisher.publish(request())).kind).toBe("processing");
  });

  it("un archivo que no se puede leer no se sube", async () => {
    const { fake, publisher } = make(routes({ file: new Uint8Array(64).fill(1) }));
    const status = await publisher.publish(request());
    expect(status.failure?.reason).toBe("unsupported_media");
    expect(fake.to("POST", "uploadType=resumable")).toHaveLength(0);
  });

  it("título de más de 100 caracteres: bad_request antes de bajar nada", async () => {
    const { fake, publisher } = make(routes());
    const error: unknown = await publisher
      .publish(request({ caption: "a".repeat(101) }))
      .catch((e: unknown) => e);
    expect(isPortError(error) && error.code).toBe("bad_request");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("youtube · estado (watcher)", () => {
  const statusRoute = (uploadStatus: string | null): Route => ({
    method: "GET",
    match: "/youtube/v3/videos?part=status",
    replies: [
      {
        json: {
          items:
            uploadStatus === null ? [] : [{ id: VIDEO_ID, status: { uploadStatus } }],
        },
      },
    ],
  });

  it.each([
    ["processed", "published"],
    ["uploaded", "processing"],
    ["rejected", "failed"],
    ["failed", "failed"],
  ])("uploadStatus %s → %s", async (uploadStatus, kind) => {
    const { publisher } = make([statusRoute(uploadStatus)]);
    const status = await publisher.getStatus({
      account: ACCOUNT,
      externalPostId: VIDEO_ID,
    });
    expect(status?.kind).toBe(kind);
  });

  it("borrado o desconocido → null", async () => {
    expect(
      await make([statusRoute(null)]).publisher.getStatus({
        account: ACCOUNT,
        externalPostId: "x",
      }),
    ).toBeNull();
    expect(
      await make([statusRoute("deleted")]).publisher.getStatus({
        account: ACCOUNT,
        externalPostId: VIDEO_ID,
      }),
    ).toBeNull();
  });
});

describe("mp4-probe", () => {
  it("lee duración y tamaño de la pista de video", () => {
    expect(probeMp4(mp4Fixture({ seconds: 12.5, width: 720, height: 1280 }))).toEqual({
      durationSeconds: 12.5,
      width: 720,
      height: 1280,
    });
  });

  it("algo que no es MP4 no inventa nada", () => {
    expect(probeMp4(new Uint8Array([0, 0, 0, 1, 2, 3]))).toEqual({
      durationSeconds: null,
      width: null,
      height: null,
    });
  });
});

describeSocialPublisherContract({ describe, it }, "youtube shorts (fetch falso)", {
  makeAdapter: () =>
    new YouTubeShortsPublisher({
      fetch: new FakeFetch([
        { method: "GET", match: "id-que-no-existe", replies: [{ json: { items: [] } }] },
      ]).fetch,
    }),
  account: ACCOUNT,
});
