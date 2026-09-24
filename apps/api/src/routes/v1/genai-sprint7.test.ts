/**
 * Sprint 7 (agente G), sin base:
 *
 * - `createProviderImageResolver`: una imagen **nuestra** (MinIO local, no
 *   pública) → la URL que el proveedor puede leer. Higgsfield: se sube una
 *   vez y se reusa; ComfyUI: la local; fal: sólo si ya es https.
 * - Paridad contrato ↔ core de los números que los dos repiten (el contrato
 *   es standalone y no importa `core`).
 */
import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import {
  FORMAT_RUN_OVERLAY_MAX_CHARS,
  FORMAT_RUN_TOPIC_MAX_CHARS,
  INFLUENCER_TEMPLATES_MAX,
  INFLUENCER_VIDEO_PROMPT_MAX,
  formatRunErrorCodeSchema,
  formatRunStatusSchema,
} from "@fastgram/contracts";
import {
  FORMAT_OVERLAY_MAX_CHARS,
  FORMAT_RUN_ERROR_CODES,
  FORMAT_RUN_STATUSES,
  FORMAT_TOPIC_MAX_CHARS,
  GENERATIVE_FORMATS,
  INFLUENCER_TEMPLATE_LIMITS,
  INFLUENCER_VIDEO_PROMPT_MAX as CORE_VIDEO_PROMPT_MAX,
  type ResolvedGenAiConfig,
} from "@fastgram/core";
import { describe, expect, it } from "vitest";

import { ApiRejection } from "../../http/errors.js";
import { createProviderImageResolver, type GenAiRouteDeps } from "./genai.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
const config = (provider: ResolvedGenAiConfig["provider"]): ResolvedGenAiConfig => ({
  task: "video",
  provider,
  baseUrl: "https://api.example",
  model: "m",
  apiKey: "k",
});

async function storageWith(key: string): Promise<MemoryStorage> {
  const s = new MemoryStorage(new FixedClock(new Date("2026-09-24T12:00:00Z")));
  await s.put({ key, body: PNG, contentType: "image/png" });
  return s;
}

describe("createProviderImageResolver", () => {
  const media = {
    mediaId: "3eb3ad49-775d-40bd-b5e5-38b105108780",
    storageKey: "media/c/x.png",
    r2Url: "http://localhost:9000/fastgram/media/c/x.png",
  };

  it("Higgsfield: sube los bytes una vez y reusa la URL", async () => {
    const uploads: { size: number; contentType: string }[] = [];
    const resolve = createProviderImageResolver({
      uploadImage: (
        _c: ResolvedGenAiConfig,
        image: { readonly body: Uint8Array; readonly contentType: string },
      ) => {
        uploads.push({ size: image.body.byteLength, contentType: image.contentType });
        return Promise.resolve("https://cdn.higgsfield.ai/uploads/1.png");
      },
    } as unknown as GenAiRouteDeps);
    const storage = await storageWith(media.storageKey);
    expect(await resolve(config("higgsfield"), storage, "c", media)).toBe(
      "https://cdn.higgsfield.ai/uploads/1.png",
    );
    await resolve(config("higgsfield"), storage, "c", media);
    expect(uploads).toEqual([{ size: 4, contentType: "image/png" }]);
  });

  it("ComfyUI: la URL local tal cual, sin subir nada", async () => {
    const resolve = createProviderImageResolver({} as GenAiRouteDeps);
    expect(await resolve(config("comfyui"), await storageWith("k"), "c", media)).toBe(
      media.r2Url,
    );
  });

  it("fal: 400 con un storage que no es público; https pasa", async () => {
    const resolve = createProviderImageResolver({} as GenAiRouteDeps);
    const storage = await storageWith("k");
    await expect(resolve(config("fal"), storage, "c", media)).rejects.toBeInstanceOf(
      ApiRejection,
    );
    const pub = { ...media, r2Url: "https://media.example/x.png" };
    expect(await resolve(config("fal"), storage, "c", pub)).toBe(pub.r2Url);
  });

  it("el objeto no está en el storage: 400 con el campo", async () => {
    const resolve = createProviderImageResolver({
      uploadImage: () => Promise.resolve("https://never"),
    } as unknown as GenAiRouteDeps);
    const empty = new MemoryStorage(new FixedClock(new Date()));
    await expect(resolve(config("higgsfield"), empty, "c", media)).rejects.toMatchObject({
      status: 400,
    });
  });
});

describe("paridad contrato ↔ core (sprint 7)", () => {
  it("los topes y las listas coinciden", () => {
    expect(FORMAT_RUN_OVERLAY_MAX_CHARS).toBe(FORMAT_OVERLAY_MAX_CHARS);
    expect(FORMAT_RUN_TOPIC_MAX_CHARS).toBe(FORMAT_TOPIC_MAX_CHARS);
    expect(INFLUENCER_TEMPLATES_MAX).toBe(INFLUENCER_TEMPLATE_LIMITS.maxTemplates);
    expect(INFLUENCER_VIDEO_PROMPT_MAX).toBe(CORE_VIDEO_PROMPT_MAX);
    expect(formatRunStatusSchema.options).toEqual([...FORMAT_RUN_STATUSES]);
    for (const code of FORMAT_RUN_ERROR_CODES) {
      expect(formatRunErrorCodeSchema.options).toContain(code);
    }
    expect(GENERATIVE_FORMATS).toHaveLength(17);
  });
});
