/**
 * Las dos mitades de la decisión de `main.ts`, sin red. Que cada cola use de
 * verdad la instancia que le toca lo mide `test/render-wiring.int.test.ts`,
 * atravesando `createHandlers` contra Postgres.
 */
import {
  HttpMediaRenderer,
  MemoryMediaRenderer,
  type RenderFetch,
} from "@fastgram/adapters";
import { describe, expect, it } from "vitest";

import { createRenderServiceRenderers, selectWorkerRenderers } from "./render-service.js";

const CONFIG = { baseUrl: "http://render.test:3002", grantSecret: "z".repeat(32) };

describe("selectWorkerRenderers", () => {
  it("sin servicio: memoria para los builds y la normalización sin montar", () => {
    const selected = selectWorkerRenderers(null);
    expect(selected.renderer).toBeInstanceOf(MemoryMediaRenderer);
    expect(selected.normalizationRenderer).toBeNull();
  });
});

describe("createRenderServiceRenderers", () => {
  it("una consulta de versión, dos instancias HTTP distintas", async () => {
    const calls: string[] = [];
    const fetch: RenderFetch = (input) => {
      calls.push(input);
      return Promise.resolve(
        new Response(JSON.stringify({ ffmpeg: { available: true, version: "9.0.1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    };
    const created = await createRenderServiceRenderers(CONFIG, { fetch });
    expect(calls).toEqual([`${CONFIG.baseUrl}/capabilities`]);
    expect(created.build).toBeInstanceOf(HttpMediaRenderer);
    expect(created.normalization).toBeInstanceOf(HttpMediaRenderer);
    expect(created.build).not.toBe(created.normalization);

    const selected = selectWorkerRenderers(created);
    expect(selected.renderer).toBe(created.build);
    expect(selected.normalizationRenderer).toBe(created.normalization);
  });

  it("con el servicio caído, lanza: el worker no levanta con una versión inventada", async () => {
    const fetch: RenderFetch = () => Promise.reject(new TypeError("fetch failed"));
    await expect(createRenderServiceRenderers(CONFIG, { fetch })).rejects.toThrow();
  });
});
