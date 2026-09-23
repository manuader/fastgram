/**
 * Que el renderer de `media-normalization` sale armado como hace falta: versión
 * de motor pedida al servicio, y **cada pedido con un grant firmado con el
 * secreto del entorno** — sin eso, el servicio (con `RENDER_REQUIRE_GRANT=true`,
 * su default) rechaza todo.
 *
 * Sin red: `fetch` falso. Lo que esto NO prueba es que el servicio real acepte
 * la firma; eso lo mide el test de integración del adaptador.
 */
import { createHmac } from "node:crypto";

import { FixedClock, type RenderFetch } from "@fastgram/adapters";
import { describe, expect, it } from "vitest";

import {
  createNormalizationRenderer,
  NORMALIZATION_GRANT_TTL_MS,
} from "./normalization-renderer.js";

const SECRETO_DE_PRUEBA = "y".repeat(32);
const BASE = "http://render.test:3002";
const COMPANY = "3f1c2a9e-8b7d-4c6e-9f0a-1b2c3d4e5f60";

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

function fakeService(capabilities: unknown): { fetch: RenderFetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: RenderFetch = (input, init) => {
    calls.push({
      url: input,
      method: init.method,
      body: init.body === undefined ? undefined : (JSON.parse(init.body) as unknown),
    });
    const json = (value: unknown): Response =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (input.endsWith("/capabilities")) return Promise.resolve(json(capabilities));
    if (input.endsWith("/probe")) {
      return Promise.resolve(
        json({
          contentType: "video/quicktime",
          width: 1080,
          height: 1920,
          hasAudio: true,
          isHdr: false,
          isFastStart: false,
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  };
  return { fetch, calls };
}

/** La serialización canónica del contrato: claves alfabéticas, arrays ordenados. */
function hmacOf(body: Record<string, unknown>): string {
  const canonical = Object.fromEntries(
    Object.keys(body)
      .sort()
      .map((k) => {
        const v = body[k];
        return [k, Array.isArray(v) ? [...(v as string[])].sort() : v];
      }),
  );
  return createHmac("sha256", SECRETO_DE_PRUEBA)
    .update(JSON.stringify(canonical))
    .digest("hex");
}

describe("createNormalizationRenderer", () => {
  it("pide la versión del motor y firma cada probe con el secreto del entorno", async () => {
    const service = fakeService({ ffmpeg: { available: true, version: "7.1" } });
    const clock = new FixedClock("2026-09-23T00:00:00.000Z");
    const renderer = await createNormalizationRenderer(
      { baseUrl: BASE, grantSecret: SECRETO_DE_PRUEBA },
      { fetch: service.fetch, clock },
    );

    const probe = await renderer.probe("http://s3.test/b/media/x.mov", {
      companyId: COMPANY,
      mediaPrefixes: ["http://s3.test/b/media/"],
      sharedPrefixes: [],
    });
    expect(probe.contentType).toBe("video/quicktime");

    expect(service.calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${BASE}/capabilities`,
      `POST ${BASE}/probe`,
    ]);
    const sent = service.calls[1]?.body as {
      grant?: { body: Record<string, unknown>; signature: string };
    };
    expect(sent.grant).toBeDefined();
    const grant = sent.grant as { body: Record<string, unknown>; signature: string };
    expect(grant.body["companyId"]).toBe(COMPANY);
    expect(grant.body["expiresAt"]).toBe(clock.nowMs() + NORMALIZATION_GRANT_TTL_MS);
    expect(grant.signature).toBe(hmacOf(grant.body));
    // El secreto firma; no viaja.
    expect(JSON.stringify(sent)).not.toContain(SECRETO_DE_PRUEBA);
  });

  it("un servicio sin FFmpeg no deja armar el renderer (el worker no levanta)", async () => {
    const service = fakeService({ ffmpeg: { available: false } });
    await expect(
      createNormalizationRenderer(
        { baseUrl: BASE, grantSecret: SECRETO_DE_PRUEBA },
        { fetch: service.fetch },
      ),
    ).rejects.toThrow(/ffmpeg/);
  });
});
