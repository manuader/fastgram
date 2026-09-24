/**
 * `PU-MEDIA-002` — `HttpMediaRenderer.generateBrandBackground` contra un
 * `fetch` falso con la forma de `services/render` (`POST /brand-backgrounds`).
 *
 * Lo que se mide es el cable: qué cuerpo sale (paleta, semilla, formato,
 * grant firmado), cómo se abre el artefacto por el `href`, y cómo se traducen
 * los errores del servicio. Que el servicio real devuelva esa forma lo mide
 * `services/render/src/render/brandBackground.integration.test.ts`; el test de
 * integración del worker lo atraviesa con esta misma clase.
 */
import { createHmac } from "node:crypto";
import { PortError, type MediaAuthorization } from "@fastgram/ports";
import { describe, expect, it } from "vitest";
import { FixedClock } from "../clock/index.js";
import { canonicalGrantBody, type MediaGrantBody } from "./media-grant.js";
import { HttpMediaRenderer, type RenderFetch } from "./http-media-renderer.js";

const BASE = "http://render.test:3002";
const SECRET = "k".repeat(40);
const AUTH: MediaAuthorization = {
  companyId: "11111111-1111-4111-8111-111111111111",
  mediaPrefixes: [],
  sharedPrefixes: [],
};
const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

interface Call {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
}

function service(
  answer: (call: Call) => Response = () =>
    json(200, {
      contentType: "image/jpeg",
      sizeBytes: BYTES.length,
      width: 1080,
      height: 1350,
      href: "/artifact/abc.jpg",
      cache: "miss",
      warnings: [],
    }),
): { fetch: RenderFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: RenderFetch = (input, init) => {
    const call: Call = {
      method: init.method,
      path: input.slice(BASE.length),
      body:
        init.body === undefined
          ? null
          : (JSON.parse(init.body) as Record<string, unknown>),
    };
    calls.push(call);
    if (call.path.startsWith("/artifact/")) {
      return Promise.resolve(
        new Response(BYTES, {
          status: 200,
          headers: {
            "content-type": "image/jpeg",
            "content-length": String(BYTES.length),
          },
        }),
      );
    }
    return Promise.resolve(answer(call));
  };
  return { fetch, calls };
}

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderer(fetch: RenderFetch): HttpMediaRenderer {
  return new HttpMediaRenderer({
    baseUrl: BASE,
    engineVersion: "test-engine",
    grantSecret: SECRET,
    fetch,
    clock: new FixedClock(new Date("2026-09-24T10:00:00.000Z")),
  });
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<number> {
  let n = 0;
  for await (const chunk of body) n += chunk.byteLength;
  return n;
}

describe("HttpMediaRenderer.generateBrandBackground", () => {
  it("imagen: manda paleta, semilla, formato y un grant que verifica", async () => {
    const svc = service();
    const media = await renderer(svc.fetch).generateBrandBackground(
      { kind: "image", palette: ["#112233", "#AABBCC"], seed: "s1", aspectRatio: "4:5" },
      AUTH,
    );
    expect(media).toMatchObject({
      contentType: "image/jpeg",
      width: 1080,
      height: 1350,
      sizeBytes: BYTES.length,
    });
    expect(await drain(media.body)).toBe(BYTES.length);

    const post = svc.calls[0];
    expect(post?.method).toBe("POST");
    expect(post?.path).toBe("/brand-backgrounds");
    expect(post?.body).toMatchObject({
      palette: ["#112233", "#AABBCC"],
      seed: "s1",
      kind: "image",
      aspectRatio: "4:5",
    });
    expect(post?.body).not.toHaveProperty("durationSeconds");

    // La firma es la que el servicio va a recomputar: mismo cuerpo canónico.
    const grant = post?.body?.["grant"] as { body: MediaGrantBody; signature: string };
    expect(grant.body.companyId).toBe(AUTH.companyId);
    expect(grant.signature).toBe(
      createHmac("sha256", SECRET).update(canonicalGrantBody(grant.body)).digest("hex"),
    );
    expect(svc.calls[1]?.path).toBe("/artifact/abc.jpg");
  });

  it("video: 9:16 y la duración pedida", async () => {
    const svc = service(() =>
      json(200, {
        contentType: "video/mp4",
        sizeBytes: BYTES.length,
        width: 1080,
        height: 1920,
        durationSeconds: 8,
        href: "/artifact/abc.mp4",
      }),
    );
    const media = await renderer(svc.fetch).generateBrandBackground(
      { kind: "video", palette: ["#112233", "#AABBCC"], seed: "v", durationSeconds: 8 },
      AUTH,
    );
    expect(media).toMatchObject({ contentType: "video/mp4", durationSeconds: 8 });
    expect(svc.calls[0]?.body).toMatchObject({
      kind: "video",
      aspectRatio: "9:16",
      durationSeconds: 8,
    });
  });

  it("un servicio que devuelve otro tipo del pedido viola el contrato", async () => {
    const svc = service(() =>
      json(200, {
        contentType: "video/mp4",
        sizeBytes: BYTES.length,
        width: 1080,
        height: 1920,
        href: "/artifact/abc.mp4",
      }),
    );
    await expect(
      renderer(svc.fetch).generateBrandBackground(
        {
          kind: "image",
          palette: ["#112233", "#AABBCC"],
          seed: "x",
          aspectRatio: "9:16",
        },
        AUTH,
      ),
    ).rejects.toMatchObject({ code: "provider_contract_violation" });
  });

  it("los errores del servicio se traducen a códigos del puerto", async () => {
    const cases = [
      { status: 400, code: "bad_request", port: "bad_request", retryable: false },
      { status: 400, code: "media_grant_invalid", port: "bad_request", retryable: false },
      {
        status: 500,
        code: "render_failed",
        port: "provider_unavailable",
        retryable: true,
      },
      { status: 504, code: "render_timeout", port: "timeout", retryable: true },
    ] as const;
    for (const c of cases) {
      const svc = service(() =>
        json(c.status, {
          error: { code: c.code, message: "stderr crudo /tmp/x", details: {} },
        }),
      );
      const error = await renderer(svc.fetch)
        .generateBrandBackground(
          {
            kind: "image",
            palette: ["#112233", "#AABBCC"],
            seed: "x",
            aspectRatio: "9:16",
          },
          AUTH,
        )
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(PortError);
      expect((error as PortError).code).toBe(c.port);
      expect((error as PortError).isRetryable).toBe(c.retryable);
      // Nada del cuerpo crudo en el mensaje: sólo en `cause`.
      expect((error as PortError).message).not.toContain("/tmp/x");
    }
  });
});
