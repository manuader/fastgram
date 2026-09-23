/**
 * El handler de `media-normalization`, contra Postgres — §9.5 #7, `NFR-014`,
 * `FR-100`, `ERR-P11`.
 *
 * `FR-100`: los videos quedan `processing` *«hasta `ready` o `failed`»*. Lo que
 * este archivo persigue no es «normaliza bien»; son los otros casos:
 *
 *  - que nunca toque un asset de **otro workspace**, aunque el job lo pida;
 *  - que una **reentrega** no haga nada (ni llame al motor);
 *  - que un error permanente no se reintente y uno transitorio sí, y que el
 *    último intento **cierre** el asset en vez de dejarlo `processing`;
 *  - que un `DELETE` durante el trabajo no deje un normalizado huérfano.
 *
 * Corre con `SET LOCAL ROLE fastgram_app` (RLS activo), igual que
 * `build.int.test.ts`. El aislamiento sin RLS lo mide
 * `packages/db/test/media-normalization.int.test.ts`.
 */
import { FixedClock, MemoryStorage, canonicalObjectUrl } from "@fastgram/adapters";
import { JOB_QUEUES } from "@fastgram/core";
import {
  APP_ROLE,
  media,
  migrateWithUrl,
  withoutCompany,
  type DbHandle,
} from "@fastgram/db";
import {
  PortError,
  type JobContext,
  type MediaAuthorization,
  type MediaProbe,
  type MediaRenderer,
  type NormalizeRequest,
  type RenderBuild,
  type RenderedMedia,
  type RenderResult,
  type ThumbnailRequest,
} from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createMediaNormalizationHandler } from "../src/media/normalization-handler.js";
import { DATABASE_URL, openDb, seedCompany } from "./helpers/fixtures.js";

const NOW = new Date("2026-09-23T12:00:00.000Z");
const clock = new FixedClock(NOW);

let handle: DbHandle;
let alpha: string;
let beta: string;

/**
 * Doble del puerto **completo**: `implements MediaRenderer` hace que el
 * compilador lo compare con el puerto (trampa 42). Los tres métodos de render
 * lanzan: el handler no tiene por qué llamarlos, y si lo hiciera el test lo
 * diría en vez de pasar sobre un valor inventado.
 */
class FakeRenderer implements MediaRenderer {
  /** Lo que `probe` responde. */
  probeResult: MediaProbe = {
    contentType: "video/quicktime",
    width: 1080,
    height: 1920,
    durationSeconds: 7.4,
    hasAudio: true,
    isHdr: false,
    isFastStart: false,
  };
  probeError: Error | null = null;
  normalizeError: Error | null = null;
  /** Corre dentro de `normalize`, antes de devolver: la ventana de la carrera. */
  duranteNormalize: (() => Promise<void>) | null = null;
  readonly probes: { url: string; auth: MediaAuthorization }[] = [];
  readonly normalizes: { request: NormalizeRequest; auth: MediaAuthorization }[] = [];

  async render(): Promise<RenderResult> {
    throw new Error("el handler de normalización no rinde");
  }
  async renderAll(): Promise<RenderBuild> {
    throw new Error("el handler de normalización no rinde");
  }
  fingerprint(): string {
    throw new Error("el handler de normalización no rinde");
  }
  async thumbnail(_request: ThumbnailRequest): Promise<RenderedMedia> {
    throw new Error("el handler de normalización no pide thumbnails");
  }

  async probe(url: string, auth: MediaAuthorization): Promise<MediaProbe> {
    this.probes.push({ url, auth });
    if (this.probeError !== null) throw this.probeError;
    return this.probeResult;
  }

  async normalize(
    request: NormalizeRequest,
    auth: MediaAuthorization,
  ): Promise<RenderedMedia> {
    this.normalizes.push({ request, auth });
    if (this.duranteNormalize !== null) await this.duranteNormalize();
    if (this.normalizeError !== null) throw this.normalizeError;
    const bytes = new TextEncoder().encode("mp4-normalizado-de-verdad");
    return {
      body: (async function* () {
        yield bytes;
      })(),
      contentType: request.targetContentType,
      sizeBytes: bytes.byteLength,
      width: 1080,
      height: 1920,
      durationSeconds: 7.6,
    };
  }
}

const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

let renderer: FakeRenderer;
let storage: MemoryStorage;

function handler() {
  return createMediaNormalizationHandler({
    db: handle.db,
    renderer,
    storage,
    clock,
    appRole: APP_ROLE,
    logger: silencioso,
  });
}

const ctx = (payload: unknown, attempt = 1, maxAttempts = 3): JobContext<unknown> => ({
  jobId: "job_norm",
  payload,
  attempt,
  maxAttempts,
});

/** Un video `processing` recién finalizado, con su objeto en el storage. */
async function videoSubido(
  companyId: string,
  status: "processing" | "ready" | "failed" = "processing",
): Promise<{ mediaId: string; key: string }> {
  const key = `media/${companyId}/${crypto.randomUUID()}.mov`;
  await storage.put({
    key,
    body: new TextEncoder().encode("mov-original"),
    contentType: "video/quicktime",
  });
  const r2Url = await canonicalObjectUrl(storage, key);
  const mediaId = await withoutCompany(handle.db, async (tx) => {
    const [row] = await tx
      .insert(media)
      .values({
        companyId,
        mediaType: "video",
        filename: "clip.mov",
        r2Url,
        storageKey: key,
        status,
        sizeMb: 5,
        origin: "manual_upload",
      })
      .returning({ id: media.mediaId });
    if (row === undefined) throw new Error("no se creó el media");
    return row.id;
  });
  return { mediaId, key };
}

async function fila(mediaId: string) {
  const filas = await handle.sql`
    select status, storage_key, r2_url, size_mb, video_duration_sec, deleted_at
    from media where media_id = ${mediaId}::uuid
  `;
  return filas[0] as unknown as {
    status: string;
    storage_key: string;
    r2_url: string;
    size_mb: number;
    video_duration_sec: number | null;
    deleted_at: unknown;
  };
}

beforeAll(async () => {
  await migrateWithUrl(DATABASE_URL);
  handle = openDb();
  alpha = await seedCompany(handle);
  beta = await seedCompany(handle);
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(() => {
  renderer = new FakeRenderer();
  storage = new MemoryStorage(clock, "memory://bucket");
});

describe("el camino feliz", () => {
  it("un MOV sale MP4: ready, clave nueva bajo media/<company>/, tamaño y duración del normalizado", async () => {
    const { mediaId, key } = await videoSubido(alpha);

    await handler()(ctx({ companyId: alpha, mediaId }));

    const row = await fila(mediaId);
    expect(row.status).toBe("ready");
    expect(row.storage_key).not.toBe(key);
    // Bajo el prefijo que el grant del workspace autoriza: si no, el próximo
    // build que use este video falla con `fuera_del_grant`.
    expect(row.storage_key.startsWith(`media/${alpha}/normalized/${mediaId}/`)).toBe(
      true,
    );
    expect(row.r2_url).not.toContain("?");
    expect(row.size_mb).toBeCloseTo(
      new TextEncoder().encode("mp4-normalizado-de-verdad").byteLength / (1024 * 1024),
      9,
    );
    // 7.6 del normalizado, redondeado: `videoDurationSec` es entero.
    expect(row.video_duration_sec).toBe(8);

    // El objeto nuevo existe; el original no se borró (el PRD no lo dice).
    expect(await storage.head(row.storage_key)).not.toBeNull();
    expect(await storage.head(key)).not.toBeNull();

    // Pidió MP4, sobre la URL del original, con un grant de ESTE workspace que
    // lista exactamente esa URL.
    const sourceUrl = await canonicalObjectUrl(storage, key);
    expect(renderer.normalizes).toHaveLength(1);
    expect(renderer.normalizes[0]?.request).toEqual({
      url: sourceUrl,
      targetContentType: "video/mp4",
    });
    const auth = renderer.probes[0]?.auth;
    expect(auth?.companyId).toBe(alpha);
    expect(auth?.urls).toEqual([sourceUrl]);
    expect(auth?.mediaPrefixes).toContain(
      await canonicalObjectUrl(storage, `media/${alpha}/`),
    );
    expect(auth?.mediaPrefixes.some((p) => p.includes(beta))).toBe(false);
  });

  it("un MP4 SDR con faststart no se transcodifica: ready con la misma clave", async () => {
    const { mediaId, key } = await videoSubido(alpha);
    renderer.probeResult = {
      ...renderer.probeResult,
      contentType: "video/mp4",
      isFastStart: true,
      durationSeconds: 4.2,
    };

    await handler()(ctx({ companyId: alpha, mediaId }));

    expect(renderer.normalizes).toHaveLength(0);
    const row = await fila(mediaId);
    expect(row.status).toBe("ready");
    expect(row.storage_key).toBe(key);
    expect(row.size_mb).toBe(5);
    expect(row.video_duration_sec).toBe(4);
  });

  it("un MP4 HDR sí se normaliza (HDR→SDR)", async () => {
    const { mediaId } = await videoSubido(alpha);
    renderer.probeResult = {
      ...renderer.probeResult,
      contentType: "video/mp4",
      isFastStart: true,
      isHdr: true,
    };
    await handler()(ctx({ companyId: alpha, mediaId }));
    expect(renderer.normalizes).toHaveLength(1);
    expect((await fila(mediaId)).status).toBe("ready");
  });
});

describe("aislamiento: el job no puede tocar otro workspace", () => {
  it("un job con el companyId de beta sobre un asset de alpha no hace nada", async () => {
    const { mediaId, key } = await videoSubido(alpha);

    await handler()(ctx({ companyId: beta, mediaId }));

    // Negativas primero: el motor ni se llamó, y la fila de alpha está intacta.
    expect(renderer.probes).toHaveLength(0);
    const row = await fila(mediaId);
    expect(row.status).toBe("processing");
    expect(row.storage_key).toBe(key);
  });
});

describe("idempotencia", () => {
  it("una reentrega sobre un asset ya ready no llama al motor", async () => {
    const { mediaId } = await videoSubido(alpha);
    await handler()(ctx({ companyId: alpha, mediaId }));
    const primera = await fila(mediaId);

    renderer = new FakeRenderer();
    await handler()(ctx({ companyId: alpha, mediaId }, 2));

    expect(renderer.probes).toHaveLength(0);
    expect(await fila(mediaId)).toEqual(primera);
  });

  it("un asset borrado durante la normalización no queda con un normalizado huérfano", async () => {
    const { mediaId } = await videoSubido(alpha);
    renderer.duranteNormalize = async () => {
      await handle.sql`update media set deleted_at = now() where media_id = ${mediaId}::uuid`;
    };

    await handler()(ctx({ companyId: alpha, mediaId }));

    const row = await fila(mediaId);
    expect(row.status).toBe("processing");
    // Sólo el original: el normalizado que se subió se borró al perder el UPDATE.
    // `storage` es nuevo en cada test, así que 1 = el original y nada más.
    expect(storage.size).toBe(1);
  });

  it("un payload inválido no llama al motor ni lanza", async () => {
    await handler()(ctx({ companyId: alpha, mediaId: "no-es-uuid" }));
    await handler()(ctx(null));
    expect(renderer.probes).toHaveLength(0);
  });
});

describe("fallos", () => {
  it("ERR-P11 (not_found / bad_request del probe) es permanente: failed al primer intento", async () => {
    const { mediaId } = await videoSubido(alpha);
    renderer.probeError = new PortError("bad_request", "no es un video", {
      source: "fake",
    });

    await handler()(ctx({ companyId: alpha, mediaId }, 1, 3));

    expect((await fila(mediaId)).status).toBe("failed");
  });

  it("un fallo transitorio se reintenta: relanza y el asset sigue processing", async () => {
    const { mediaId } = await videoSubido(alpha);
    renderer.normalizeError = new PortError("provider_unavailable", "render caído", {
      source: "fake",
    });

    await expect(handler()(ctx({ companyId: alpha, mediaId }, 1, 3))).rejects.toThrow();

    expect((await fila(mediaId)).status).toBe("processing");
    // El fallo fue antes de subir: en el bucket sigue sólo el original.
    expect(storage.size).toBe(1);
  });

  it("el último intento transitorio cierra el asset como failed y no relanza", async () => {
    const { mediaId } = await videoSubido(alpha);
    renderer.normalizeError = new PortError("timeout", "tardó demasiado", {
      source: "fake",
    });

    await handler()(ctx({ companyId: alpha, mediaId }, 3, 3));

    expect((await fila(mediaId)).status).toBe("failed");
  });
});

describe("el cableado de createHandlers", () => {
  /**
   * La razón de ser de `normalizationRenderer` es que la normalización NO use
   * el renderer de `content-build`, que hoy es el de memoria y marcaría
   * `failed` cada video real. Cambiar una línea en `handlers.ts` para pasarle
   * `deps.renderer` dejaba verdes los tests de `handlers.test.ts` (sólo miran
   * qué colas se montan): éste es el que lo ve.
   */
  it("media-normalization usa el renderer de normalización, nunca el de content-build", async () => {
    const { createHandlers } = await import("../src/handlers.js");
    const { mediaId } = await videoSubido(alpha);
    const trampa = new FakeRenderer();
    trampa.probeError = new Error("usó el renderer de content-build");

    const { handlers } = createHandlers({
      db: handle.db,
      renderer: trampa,
      normalizationRenderer: renderer,
      storage,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
    });
    const normalizar = handlers[JOB_QUEUES.mediaNormalization];
    if (normalizar === undefined) throw new Error("media-normalization no se montó");

    await normalizar(ctx({ companyId: alpha, mediaId }));

    expect(trampa.probes).toHaveLength(0);
    expect(renderer.probes).toHaveLength(1);
    expect((await fila(mediaId)).status).toBe("ready");
  });
});
