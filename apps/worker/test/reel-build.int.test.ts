/**
 * Rama `reel` del handler de build (`PU-S9-010`), contra Postgres.
 *
 * Lo que se fija: que un reel se construya por `renderReel` (no por
 * `renderAll`), con un grant que lista exactamente su media; que el spec
 * editado (`studioState.reel`) sea el que se renderiza; y que sin renderer de
 * reels o con un spec editado roto la pieza termine `FAILED` con código estable
 * y el save devuelto — no colgada en `BUILDING`.
 */
import { FixedClock, MemoryMediaRenderer, MemoryStorage } from "@fastgram/adapters";
import { APP_ROLE, migrateWithUrl, type DbHandle } from "@fastgram/db";
import type {
  JobContext,
  MediaAuthorization,
  MediaRenderer,
  ReelRenderBuild,
  ReelRenderJob,
  ReelRenderer,
} from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createContentBuildHandler,
  type BuildLogger,
} from "../src/content/build-handler.js";
import { createContentRebuildHandler } from "../src/content/rebuild-handler.js";
import { DATABASE_URL, PERIOD, openDb, seedCompany } from "./helpers/fixtures.js";
import { reelSpec } from "./helpers/reel.js";

const NOW = new Date("2026-09-28T12:00:00.000Z");
const clock = new FixedClock(NOW);
const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

let handle: DbHandle;
let companyId: string;
let storage: MemoryStorage;

/** El de memoria para todo lo demás (thumbnail), más `renderReel` falso. */
class ReelRendererFalso extends MemoryMediaRenderer implements ReelRenderer {
  calls: { job: ReelRenderJob; auth: MediaAuthorization }[] = [];
  async renderReel(
    job: ReelRenderJob,
    auth: MediaAuthorization,
  ): Promise<ReelRenderBuild> {
    this.calls.push({ job, auth });
    const bytes = new TextEncoder().encode(`mp4:${JSON.stringify(job.spec).length}`);
    return {
      artifact: {
        kind: "video",
        index: 0,
        sizeBytes: bytes.byteLength,
        open: async () => ({
          body: (async function* () {
            yield bytes;
          })(),
          contentType: "video/mp4",
          sizeBytes: bytes.byteLength,
          width: 1080,
          height: 1920,
        }),
      },
      captions: {},
      warnings: [],
      renderMs: 1,
    };
  }
  async previewReel(): Promise<never> {
    throw new Error("no se usa en el worker");
  }
}

function rebuildHandler(renderer: MediaRenderer) {
  return createContentRebuildHandler({
    db: handle.db,
    renderer,
    storage,
    clock,
    appRole: APP_ROLE,
    logger: silencioso,
  });
}

function handler(renderer: MediaRenderer) {
  return createContentBuildHandler({
    db: handle.db,
    renderer,
    storage,
    clock,
    appRole: APP_ROLE,
    logger: silencioso,
  });
}

const ctx = (payload: unknown): JobContext<unknown> => ({
  jobId: "job_reel",
  payload,
  attempt: 1,
  maxAttempts: 3,
});

async function mediaBase(): Promise<string> {
  // La URL canónica del Media Bank del workspace, como la escribe la API.
  return `memory://bucket/media/${companyId}/`;
}

async function seedReel(
  buildPayload: unknown,
  studioState: unknown = null,
): Promise<string> {
  await handle.sql`
    insert into quota_ledgers (company_id, period, content_saves_included, content_saves_used)
    values (${companyId}::uuid, ${PERIOD}, 500, 1)
    on conflict (company_id, period) do update
      set content_saves_used = quota_ledgers.content_saves_used + 1
  `;
  // Texto + `::jsonb` y no `sql.json`: `drizzle()` le cambió los serializadores
  // al cliente (trampa 18) y `sql.json` llega como objeto sin serializar.
  const rows = await handle.sql`
    insert into contents (company_id, type, status, revision, build_payload, studio_state, save_bucket, save_period)
    values (${companyId}::uuid, 'reel', 'BUILDING', 1, ${JSON.stringify(buildPayload)}::jsonb,
            ${studioState === null ? null : JSON.stringify(studioState)}::jsonb, 'included', ${PERIOD})
    returning id
  `;
  return (rows[0] as unknown as { id: string }).id;
}

async function pieza(id: string) {
  // Texto + `::jsonb` y no `sql.json`: `drizzle()` le cambió los serializadores
  // al cliente (trampa 18) y `sql.json` llega como objeto sin serializar.
  const rows = await handle.sql`
    select status, files, last_edit, save_refunded_at from contents where id = ${id}::uuid
  `;
  return rows[0] as unknown as {
    status: string;
    files: string[];
    last_edit: Record<string, unknown> | null;
    save_refunded_at: unknown;
  };
}

const job = (contentId: string) => ({
  companyId,
  contentId,
  contentType: "reel",
  revision: 1,
  reason: "create",
});

beforeAll(async () => {
  await migrateWithUrl(DATABASE_URL);
  handle = openDb();
  companyId = await seedCompany(handle);
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(() => {
  storage = new MemoryStorage(clock, "memory://bucket");
});

describe("build de un reel", () => {
  it("renderiza por renderReel en delivery, con grant de exactamente su media, y cierra CREATED", async () => {
    const renderer = new ReelRendererFalso();
    const spec = reelSpec(await mediaBase());
    const id = await seedReel({ reel: spec });

    await handler(renderer)(ctx(job(id)));

    const row = await pieza(id);
    expect(row.status).toBe("CREATED");
    expect(row.files).toHaveLength(1);
    expect(renderer.calls).toHaveLength(1);
    expect(renderer.calls[0]?.job.quality).toBe("delivery");
    expect(renderer.calls[0]?.auth.urls).toEqual([
      `${await mediaBase()}bg.jpg`,
      `${await mediaBase()}gs.mp4`,
      `memory://bucket/audio/${companyId}/m.mp3`,
    ]);
  });

  it("sin renderer de reels: FAILED con código estable y el save devuelto", async () => {
    const id = await seedReel({ reel: reelSpec(await mediaBase()) });

    await handler(new MemoryMediaRenderer())(ctx(job(id)));

    const row = await pieza(id);
    expect(row.status).toBe("FAILED");
    expect(row.save_refunded_at).not.toBeNull();
    expect(row.last_edit?.["failureReason"]).toBe("reel_renderer_unavailable");
  });

  // Las ediciones llegan por la cola `content-rebuild` (`PUT /content/:id/reel`
  // → `bumpAndRebuild`): es el rebuild el que lee `studioState`. Un build de
  // creación no tiene ediciones.
  it("rebuild: el spec editado del editor es el que se renderiza", async () => {
    const renderer = new ReelRendererFalso();
    const spec = reelSpec(await mediaBase());
    const edited = {
      ...spec,
      layers: spec.layers.map((l) => (l.kind === "text" ? { ...l, text: "Edited!" } : l)),
    };
    const id = await seedReel({ reel: spec }, { reel: edited });

    await rebuildHandler(renderer)(ctx({ ...job(id), reason: "edit" }));

    expect((await pieza(id)).status).toBe("CREATED");
    const layers = (
      renderer.calls[0]?.job.spec as { layers: { id: string; text?: string }[] }
    ).layers;
    expect(layers.find((l) => l.id === "hook")?.text).toBe("Edited!");
  });

  it("rebuild: un spec editado roto no se renderiza con el original; la versión anterior sigue", async () => {
    const renderer = new ReelRendererFalso();
    const spec = reelSpec(await mediaBase());
    const id = await seedReel({ reel: spec }, { reel: { ...spec, durationSec: 999 } });

    await rebuildHandler(renderer)(ctx({ ...job(id), reason: "edit" }));

    const row = await pieza(id);
    expect(renderer.calls).toHaveLength(0);
    expect(row.status).toBe("CREATED");
    expect(row.last_edit).toMatchObject({
      outcome: "failed",
      failureReason: "edit_not_renderable",
    });
  });
});
