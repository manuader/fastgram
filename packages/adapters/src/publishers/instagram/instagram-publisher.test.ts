/**
 * Instagram contra un `fetch` falso con las respuestas **documentadas**:
 * https://developers.facebook.com/docs/instagram-platform/content-publishing
 * (contenedor `{"id": …}`, `status_code`, `media_publish` → `{"id": …}`),
 * https://developers.facebook.com/docs/graph-api/guides/error-handling (forma
 * del error) y los subcódigos de
 * https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/error-codes
 */
import { describe, expect, it } from "vitest";
import {
  PortError,
  describeSocialPublisherContract,
  isPublishDeliveryUncertain,
  type PublishRequest,
} from "@fastgram/ports";

import { FakeFetch, bodyOf, noSleep, type Route } from "../__tests__/fake-fetch.js";
import { InstagramPublisher } from "./instagram-publisher.js";

const HOST = "https://graph.instagram.com/v26.0";
const ACCOUNT = {
  accountType: "oauth" as const,
  accountId: "conn-1",
  accessToken: "tok-ig",
  platformUserId: "17841400000000000",
};

const request = (over: Partial<PublishRequest> = {}): PublishRequest => ({
  account: ACCOUNT,
  media: { kind: "video", urls: ["https://tunnel.example/public-media/abc"] },
  caption: "hola",
  idempotencyKey: `publish:${Math.random().toString(36).slice(2)}`,
  ...over,
});

const graphError = (code: number, subcode?: number, status = 400) => ({
  status,
  json: {
    error: {
      message: "Message describing the error",
      type: "OAuthException",
      code,
      ...(subcode === undefined ? {} : { error_subcode: subcode }),
      fbtrace_id: "EJplcsCHuLu",
    },
  },
});

function happyRoutes(over: { status?: Route; publish?: Route } = {}): Route[] {
  return [
    { method: "POST", match: /\/media$/, replies: [{ json: { id: "cont-1" } }] },
    over.status ?? {
      method: "GET",
      match: "/cont-1?",
      replies: [
        { json: { status_code: "IN_PROGRESS" } },
        { json: { status_code: "FINISHED" } },
      ],
    },
    over.publish ?? {
      method: "POST",
      match: "/media_publish",
      replies: [{ json: { id: "media-99" } }],
    },
    {
      method: "GET",
      match: "/media-99?",
      replies: [
        { json: { permalink: "https://www.instagram.com/reel/abc/", id: "media-99" } },
      ],
    },
  ];
}

const make = (routes: Route[]) => {
  const fake = new FakeFetch(routes);
  const publisher = new InstagramPublisher({
    fetch: fake.fetch,
    sleep: noSleep,
    pollTimeoutMs: 60_000,
  });
  return { fake, publisher };
};

describe("Instagram · camino feliz", () => {
  it("reel: contenedor REELS → espera FINISHED → media_publish → permalink", async () => {
    const { fake, publisher } = make(happyRoutes());

    const status = await publisher.publish(request());

    expect(status).toEqual({
      kind: "published",
      externalPostId: "media-99",
      permalink: "https://www.instagram.com/reel/abc/",
    });
    const container = fake.to("POST", /\/media$/)[0];
    expect(container?.url).toBe(`${HOST}/${ACCOUNT.platformUserId}/media`);
    expect(container?.headers["Authorization"]).toBe("Bearer tok-ig");
    expect(bodyOf(container)).toEqual({
      media_type: "REELS",
      video_url: "https://tunnel.example/public-media/abc",
      caption: "hola",
    });
    expect(bodyOf(fake.to("POST", "/media_publish")[0])).toEqual({
      creation_id: "cont-1",
    });
    // Consultó el estado dos veces: IN_PROGRESS y FINISHED.
    expect(fake.to("GET", "/cont-1")).toHaveLength(2);
  });

  it("imagen: un slideshow de una sola imagen es `image_url`", async () => {
    const { fake, publisher } = make(happyRoutes());
    await publisher.publish(
      request({ media: { kind: "slideshow", urls: ["https://t.example/1.jpg"] } }),
    );
    expect(bodyOf(fake.to("POST", /\/media$/)[0])).toEqual({
      image_url: "https://t.example/1.jpg",
      caption: "hola",
    });
  });

  it("carrusel: hijos con is_carousel_item y el padre con children", async () => {
    const fake = new FakeFetch([
      {
        method: "POST",
        match: /\/media$/,
        replies: [
          { json: { id: "c1" } },
          { json: { id: "c2" } },
          { json: { id: "cont-1" } },
        ],
      },
      {
        method: "GET",
        match: "/cont-1?",
        replies: [{ json: { status_code: "FINISHED" } }],
      },
      {
        method: "POST",
        match: "/media_publish",
        replies: [{ json: { id: "media-99" } }],
      },
      {
        method: "GET",
        match: "/media-99?",
        replies: [{ json: { permalink: "https://i/p" } }],
      },
    ]);
    const publisher = new InstagramPublisher({ fetch: fake.fetch, sleep: noSleep });

    await publisher.publish(
      request({
        media: { kind: "carousel", urls: ["https://t/1.jpg", "https://t/2.jpg"] },
      }),
    );

    const [a, b, parent] = fake.to("POST", /\/media$/);
    expect(bodyOf(a)).toEqual({ image_url: "https://t/1.jpg", is_carousel_item: "true" });
    expect(bodyOf(b)).toEqual({ image_url: "https://t/2.jpg", is_carousel_item: "true" });
    expect(bodyOf(parent)).toEqual({
      media_type: "CAROUSEL",
      children: "c1,c2",
      caption: "hola",
    });
  });

  it("más de 10 ítems falla sin llamar a la plataforma", async () => {
    const { fake, publisher } = make([]);
    const urls = Array.from({ length: 11 }, (_, i) => `https://t/${String(i)}.jpg`);
    const status = await publisher.publish(
      request({ media: { kind: "carousel", urls } }),
    );
    expect(status.kind).toBe("failed");
    expect(status.failure?.reason).toBe("unsupported_media");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("Instagram · errores traducidos", () => {
  it("tope de publicación (9/2207042) → post_limit_exceeded", async () => {
    const { publisher } = make(
      happyRoutes({
        publish: {
          method: "POST",
          match: "/media_publish",
          replies: [graphError(9, 2207042)],
        },
      }),
    );
    const status = await publisher.publish(request());
    expect(status).toEqual({
      kind: "failed",
      failure: {
        reason: "post_limit_exceeded",
        message: "The account reached the platform's daily posting limit.",
      },
    });
  });

  it("demasiadas llamadas (código 4) → rate_limited reintentable", async () => {
    const { publisher } = make([
      { method: "POST", match: /\/media$/, replies: [graphError(4)] },
    ]);
    const error = await publisher.publish(request()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PortError);
    expect((error as PortError).code).toBe("rate_limited");
    expect((error as PortError).isRetryable).toBe(true);
  });

  it("token vencido (190) → unauthorized, que lleva a AWAITING_RECONNECT", async () => {
    const { publisher } = make([
      { method: "POST", match: /\/media$/, replies: [graphError(190, 463, 401)] },
    ]);
    await expect(publisher.publish(request())).rejects.toMatchObject({
      code: "unauthorized",
    });
  });

  it("media rechazada (352/2207026) → unsupported_media", async () => {
    const { publisher } = make([
      { method: "POST", match: /\/media$/, replies: [graphError(352, 2207026)] },
    ]);
    const status = await publisher.publish(request());
    expect(status.failure?.reason).toBe("unsupported_media");
  });

  it("contenedor en ERROR → unsupported_media, sin publicar", async () => {
    const { fake, publisher } = make(
      happyRoutes({
        status: {
          method: "GET",
          match: "/cont-1?",
          replies: [{ json: { status_code: "ERROR" } }],
        },
      }),
    );
    const status = await publisher.publish(request());
    expect(status.failure?.reason).toBe("unsupported_media");
    expect(fake.to("POST", "/media_publish")).toHaveLength(0);
  });

  it("ningún mensaje trae el crudo de la plataforma", async () => {
    const { publisher } = make([
      {
        method: "POST",
        match: /\/media$/,
        replies: [
          { status: 400, json: { error: { message: "SECRETO-CRUDO", code: 100 } } },
        ],
      },
    ]);
    const status = await publisher.publish(request());
    expect(JSON.stringify(status)).not.toContain("SECRETO-CRUDO");
  });
});

describe("Instagram · no duplicar", () => {
  it("un 5xx en media_publish es entrega incierta: no reintentable y la clave queda", async () => {
    const { fake, publisher } = make(
      happyRoutes({
        publish: {
          method: "POST",
          match: "/media_publish",
          replies: [{ status: 503, json: {} }],
        },
      }),
    );
    const req = request();
    const first = await publisher.publish(req).catch((e: unknown) => e);
    expect(isPublishDeliveryUncertain(first)).toBe(true);
    expect((first as PortError).isRetryable).toBe(false);

    // Mismo `idempotencyKey`: no vuelve a llamar a media_publish.
    await publisher.publish(req).catch(() => undefined);
    expect(fake.to("POST", "/media_publish")).toHaveLength(1);
  });

  it("un contenedor que no terminó a tiempo se reutiliza en el reintento", async () => {
    const fake = new FakeFetch(
      happyRoutes({
        status: {
          method: "GET",
          match: "/cont-1?",
          replies: [
            { json: { status_code: "IN_PROGRESS" } },
            { json: { status_code: "IN_PROGRESS" } },
            { json: { status_code: "FINISHED" } },
          ],
        },
      }),
    );
    const publisher = new InstagramPublisher({
      fetch: fake.fetch,
      sleep: noSleep,
      pollIntervalMs: 1_000,
      pollTimeoutMs: 1_000,
    });
    const req = request();

    await expect(publisher.publish(req)).rejects.toMatchObject({ code: "timeout" });
    const status = await publisher.publish(req);

    expect(status.kind).toBe("published");
    // Un solo contenedor creado para los dos intentos.
    expect(fake.to("POST", /\/media$/)).toHaveLength(1);
  });

  it("misma clave con éxito devuelve lo mismo sin volver a publicar", async () => {
    const { fake, publisher } = make(happyRoutes());
    const req = request();
    const a = await publisher.publish(req);
    const b = await publisher.publish(req);
    expect(b).toEqual(a);
    expect(fake.to("POST", "/media_publish")).toHaveLength(1);
  });
});

describe("Instagram · getStatus", () => {
  it("un id que la plataforma no conoce es null", async () => {
    const { publisher } = make([
      { method: "GET", match: "/nope?", replies: [graphError(100, 33)] },
    ]);
    expect(
      await publisher.getStatus({ account: ACCOUNT, externalPostId: "nope" }),
    ).toBeNull();
  });
});

describeSocialPublisherContract({ describe, it }, "instagram (fetch falso)", {
  makeAdapter: () =>
    new InstagramPublisher({
      fetch: new FakeFetch([
        { method: "GET", match: "id-que-no-existe", replies: [graphError(100, 33)] },
      ]).fetch,
      sleep: noSleep,
    }),
  account: ACCOUNT,
});
