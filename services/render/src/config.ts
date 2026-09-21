/**
 * Configuración del servicio. Regla del repo: si falta una variable requerida,
 * el proceso NO levanta (IMPL §4, `P0-REPO-009`).
 *
 * Ningún secreto se loguea ni se devuelve por la API: `RENDER_MEDIA_GRANT_SECRET`
 * sólo se usa para verificar HMAC y nunca sale de este módulo.
 */
import path from "node:path";
import { tmpdir } from "node:os";
import { baseEnvSchema, defineEnv } from "@fastgram/config/env";
import { z } from "zod";
import { parsePrefixList, type MediaPolicyConfig } from "./media/urlPolicy.js";
import { fontLoaderOptionsFromEnv, type FontLoaderOptions } from "./render/fontLoader.js";

const booleanish = (fallback: boolean) =>
  z
    .enum(["true", "false"])
    .default(fallback ? "true" : "false")
    .transform((value) => value === "true");

export const renderEnvSchema = baseEnvSchema.extend({
  RENDER_PORT: z.coerce.number().int().min(1).max(65_535).default(3002),
  /** Prefijos (origen + ruta) del Media Bank. CSV. */
  RENDER_ALLOWED_MEDIA_PREFIXES: z.string().optional(),
  /** Prefijos de la librería compartida. Único origen válido para audio. CSV. */
  RENDER_SHARED_LIBRARY_PREFIXES: z.string().optional(),
  /** Secreto HMAC de los grants firmados. Sin esto no se aceptan grants. */
  RENDER_MEDIA_GRANT_SECRET: z.string().min(32).optional(),
  /**
   * Default `true`: sin grant firmado no se renderiza. Es la postura de
   * denegación por defecto que pide `FR-070`; este servicio no tiene base y no
   * puede decidir por su cuenta a qué workspace pertenece una URL.
   */
  RENDER_REQUIRE_GRANT: booleanish(true),
  RENDER_FONT_DIR: z.string().optional(),
  RENDER_FONT_STRICT: z.enum(["true", "false"]).default("true"),
  RENDER_CACHE_DIR: z.string().optional(),
  RENDER_NORMALIZE_INPUTS: booleanish(true),
  RENDER_ALLOW_UNTONEMAPPED_HDR: booleanish(false),
  /** `NFR-013`: imágenes 10 MB, videos 50 MB. */
  RENDER_MAX_IMAGE_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(10 * 1024 * 1024),
  RENDER_MAX_VIDEO_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  RENDER_MAX_AUDIO_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),
  RENDER_DOWNLOAD_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
});

export type RenderEnv = z.infer<typeof renderEnvSchema>;

export function loadRenderEnv(
  source: Record<string, string | undefined> = process.env,
): RenderEnv {
  return defineEnv("render-service", renderEnvSchema, source);
}

export function mediaPolicyFromEnv(
  env: RenderEnv,
  now: () => number = Date.now,
): MediaPolicyConfig {
  return {
    mediaPrefixes: parsePrefixList(env.RENDER_ALLOWED_MEDIA_PREFIXES),
    sharedPrefixes: parsePrefixList(env.RENDER_SHARED_LIBRARY_PREFIXES),
    grantSecret: env.RENDER_MEDIA_GRANT_SECRET ?? null,
    requireGrant: env.RENDER_REQUIRE_GRANT,
    now,
  };
}

export function fontOptionsFromEnv(env: RenderEnv): FontLoaderOptions {
  return fontLoaderOptionsFromEnv({
    ...(env.RENDER_FONT_DIR === undefined
      ? {}
      : { RENDER_FONT_DIR: env.RENDER_FONT_DIR }),
    RENDER_FONT_STRICT: env.RENDER_FONT_STRICT,
  });
}

export function cacheDirFromEnv(env: RenderEnv): string {
  return env.RENDER_CACHE_DIR ?? path.join(tmpdir(), "fastgram-render-cache");
}

export function maxBytesFor(env: RenderEnv, role: "image" | "video" | "audio"): number {
  if (role === "image") return env.RENDER_MAX_IMAGE_BYTES;
  if (role === "video") return env.RENDER_MAX_VIDEO_BYTES;
  return env.RENDER_MAX_AUDIO_BYTES;
}
