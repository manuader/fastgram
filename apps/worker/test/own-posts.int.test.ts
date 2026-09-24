/**
 * `own-post-import` contra Postgres — `FR-011.5.1`, `P1-ONB-008`.
 *
 * Persigue: que lo importado entre con `origin: imported` y su `source_ref`,
 * que una segunda corrida no duplique (dedupe por el índice único), que cada
 * video encole su normalización, que un post que falla no tumbe el import, y
 * que no poder listar cierre `failed` con código estable en vez de colgarse.
 *
 * `yt-dlp`, la Graph API y los tokens son dobles: lo que se mide es el
 * handler, no las redes (el listado sin login con `yt-dlp` real depende del
 * sitio y del día; ver el reporte del sprint).
 */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";

import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import { JOB_QUEUES } from "@fastgram/core";
import { APP_ROLE, migrateWithUrl, type DbHandle } from "@fastgram/db";
import type {
  ConnectionTokens,
  EnqueuedJob,
  JobContext,
  JobSpec,
  MediaDownloader,
  MediaDownloadRequest,
  Queue,
} from "@fastgram/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createOwnPostImportHandler } from "../src/own-posts/handler.js";
import type { ListOutcome, ProfileLister } from "../src/own-posts/listers.js";
import { DATABASE_URL, openDb, seedCompany } from "./helpers/fixtures.js";

const clock = new FixedClock(new Date("2026-09-24T12:00:00.000Z"));
const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

let handle: DbHandle;
let companyId: string;

class RecordingQueue implements Queue {
  readonly specs: JobSpec<unknown>[] = [];
  async enqueue<T>(spec: JobSpec<T>): Promise<EnqueuedJob> {
    this.specs.push(spec as JobSpec<unknown>);
    return { jobId: randomUUID(), created: true };
  }
  async enqueueMany(): Promise<never> {
    throw new Error("no se usa");
  }
  async work(): Promise<void> {}
  async getJob(): Promise<null> {
    return null;
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async scheduleRecurring(): Promise<void> {}
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
}

/** `yt-dlp` falso: escribe un "mp4" en el directorio de quien llama. */
class FakeDownloader implements MediaDownloader {
  readonly urls: string[] = [];
  failFor = new Set<string>();
  async download(request: MediaDownloadRequest) {
    this.urls.push(request.url);
    if (this.failFor.has(request.url))
      return { ok: false as const, code: "download_failed" as const };
    const file = path.join(request.directory, `${randomUUID()}.mp4`);
    await writeFile(file, new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]));
    return {
      ok: true as const,
      clip: {
        path: file,
        contentType: "video/mp4",
        extension: ".mp4",
        sizeBytes: 8,
        durationSeconds: 12.4,
        title: "My clip",
      },
    };
  }
}

class FakeLister implements ProfileLister {
  outcome: ListOutcome = {
    ok: true,
    items: [
      {
        ref: "tiktok:111",
        kind: "video",
        pageUrl: "https://www.tiktok.com/@acme/video/111",
      },
      {
        ref: "tiktok:222",
        kind: "video",
        pageUrl: "https://www.tiktok.com/@acme/video/222",
      },
    ],
  };
  async list(): Promise<ListOutcome> {
    return this.outcome;
  }
}

const tokens: ConnectionTokens = {
  async getAccessToken() {
    return "token-de-prueba";
  },
};

async function newImport(values: {
  source: "profile" | "connection";
  platform: string;
  profileUrl?: string;
  connectionId?: string;
  maxItems?: number;
}): Promise<string> {
  const [row] = await handle.sql<{ id: string }[]>`
    insert into own_post_imports (company_id, source, platform, profile_url, connection_id, max_items)
    values (${companyId}::uuid, ${values.source}, ${values.platform},
            ${values.profileUrl ?? null}, ${values.connectionId ?? null}::uuid, ${values.maxItems ?? 20})
    returning id
  `;
  return row?.id as string;
}

async function importRow(id: string) {
  const [row] = await handle.sql<
    {
      state: string;
      found: number;
      imported: number;
      skipped: number;
      failed: number;
      error_code: string | null;
    }[]
  >`select state, found, imported, skipped, failed, error_code from own_post_imports where id = ${id}`;
  return row;
}

const ctx = (payload: unknown): JobContext<unknown> => ({
  jobId: "job_own_posts",
  payload,
  attempt: 1,
  maxAttempts: 3,
});

beforeAll(async () => {
  await migrateWithUrl(DATABASE_URL);
  handle = openDb();
  companyId = await seedCompany(handle);
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

describe("own-post-import", () => {
  it("perfil: importa, encola la normalización, y la segunda corrida no duplica", async () => {
    const storage = new MemoryStorage(clock);
    const queue = new RecordingQueue();
    const downloader = new FakeDownloader();
    const handler = createOwnPostImportHandler({
      db: handle.db,
      storage,
      queue,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
      tokens: null,
      downloader,
      profiles: new FakeLister(),
    });

    const first = await newImport({
      source: "profile",
      platform: "tiktok",
      profileUrl: "https://www.tiktok.com/@acme",
    });
    await handler(ctx({ companyId, importId: first }));
    expect(await importRow(first)).toEqual({
      state: "done",
      found: 2,
      imported: 2,
      skipped: 0,
      failed: 0,
      error_code: null,
    });

    const rows = await handle.sql<
      {
        origin: string;
        source_ref: string;
        status: string;
        categories: string[];
        video_duration_sec: number;
      }[]
    >`select origin, source_ref, status, categories, video_duration_sec from media
      where company_id = ${companyId}::uuid and source_ref like 'tiktok:%' order by source_ref`;
    expect(rows).toEqual([
      {
        origin: "imported",
        source_ref: "tiktok:111",
        status: "processing",
        categories: ["background-video"],
        video_duration_sec: 12,
      },
      {
        origin: "imported",
        source_ref: "tiktok:222",
        status: "processing",
        categories: ["background-video"],
        video_duration_sec: 12,
      },
    ]);
    expect(
      queue.specs.filter((s) => s.queue === JOB_QUEUES.mediaNormalization),
    ).toHaveLength(2);

    // Otra vez: todo `skipped`, nada nuevo en el bucket ni en la cola.
    const second = await newImport({
      source: "profile",
      platform: "tiktok",
      profileUrl: "https://www.tiktok.com/@acme",
    });
    const before = storage.size;
    await handler(ctx({ companyId, importId: second }));
    expect(await importRow(second)).toEqual(
      expect.objectContaining({ state: "done", imported: 0, skipped: 2 }),
    );
    expect(storage.size).toBe(before);
    expect(downloader.urls).toHaveLength(2);

    // Una reentrega del job ya terminado no hace nada.
    await handler(ctx({ companyId, importId: second }));
    expect(downloader.urls).toHaveLength(2);
  });

  it("un post que no baja cuenta como failed y el resto sigue", async () => {
    const lister = new FakeLister();
    lister.outcome = {
      ok: true,
      items: [
        {
          ref: "youtube:aaaaaaa",
          kind: "video",
          pageUrl: "https://www.youtube.com/watch?v=aaaaaaa",
        },
        {
          ref: "youtube:bbbbbbb",
          kind: "video",
          pageUrl: "https://www.youtube.com/watch?v=bbbbbbb",
        },
      ],
    };
    const downloader = new FakeDownloader();
    downloader.failFor.add("https://www.youtube.com/watch?v=aaaaaaa");
    const id = await newImport({
      source: "profile",
      platform: "youtube",
      profileUrl: "https://www.youtube.com/@acme",
    });
    await createOwnPostImportHandler({
      db: handle.db,
      storage: new MemoryStorage(clock),
      queue: new RecordingQueue(),
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
      tokens: null,
      downloader,
      profiles: lister,
    })(ctx({ companyId, importId: id }));
    expect(await importRow(id)).toEqual(
      expect.objectContaining({ state: "done", found: 2, imported: 1, failed: 1 }),
    );
  });

  it("Instagram por conexión: baja la imagen directa del CDN y la deja `ready`", async () => {
    const [conn] = await handle.sql<{ id: string }[]>`
      insert into connections (company_id, platform, platform_user_id, platform_username, scopes, publishable)
      values (${companyId}::uuid, 'instagram', 'ig-1', 'acme', '{}', true) returning id
    `;
    const pedidos: string[] = [];
    const fetchFake = async (url: string): Promise<Response> => {
      pedidos.push(url);
      if (url.startsWith("https://graph.instagram.com/")) {
        return new Response(
          JSON.stringify({
            data: [
              {
                id: "900",
                media_type: "IMAGE",
                media_url: "https://cdn.ig.test/900.jpg",
              },
              {
                id: "901",
                media_type: "CAROUSEL_ALBUM",
                children: {
                  data: [
                    {
                      id: "902",
                      media_type: "IMAGE",
                      media_url: "https://cdn.ig.test/902.jpg",
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(new Uint8Array([0xff, 0xd8, 0xff]), {
        status: 200,
        headers: { "content-type": "image/jpeg" },
      });
    };
    const id = await newImport({
      source: "connection",
      platform: "instagram",
      connectionId: conn?.id as string,
    });
    await createOwnPostImportHandler({
      db: handle.db,
      storage: new MemoryStorage(clock),
      queue: new RecordingQueue(),
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
      tokens,
      downloader: null,
      profiles: null,
      fetch: fetchFake,
    })(ctx({ companyId, importId: id }));

    expect(await importRow(id)).toEqual(
      expect.objectContaining({ state: "done", found: 2, imported: 2 }),
    );
    expect(pedidos[0]).toMatch(
      /^https:\/\/graph\.instagram\.com\/v\d+\.\d+\/me\/media\?fields=/,
    );
    const rows = await handle.sql<{ status: string; media_type: string }[]>`
      select status, media_type from media
      where company_id = ${companyId}::uuid and source_ref in ('instagram:900', 'instagram:902')
    `;
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "ready" && r.media_type === "image")).toBe(
      true,
    );
  });

  it("sin poder listar: failed con código estable; sin tokens: connection_unavailable", async () => {
    const lister = new FakeLister();
    lister.outcome = { ok: false, code: "listing_failed" };
    const profile = await newImport({
      source: "profile",
      platform: "x",
      profileUrl: "https://x.com/acme",
    });
    const base = {
      db: handle.db,
      storage: new MemoryStorage(clock),
      queue: new RecordingQueue(),
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
      downloader: new FakeDownloader(),
    };
    await createOwnPostImportHandler({ ...base, tokens: null, profiles: lister })(
      ctx({ companyId, importId: profile }),
    );
    expect(await importRow(profile)).toEqual(
      expect.objectContaining({ state: "failed", error_code: "listing_failed" }),
    );

    const [conn] = await handle.sql<{ id: string }[]>`
      insert into connections (company_id, platform, platform_user_id, platform_username, scopes, publishable)
      values (${companyId}::uuid, 'youtube', 'yt-1', 'acme', '{}', true) returning id
    `;
    const viaConn = await newImport({
      source: "connection",
      platform: "youtube",
      connectionId: conn?.id as string,
    });
    await createOwnPostImportHandler({ ...base, tokens: null, profiles: null })(
      ctx({ companyId, importId: viaConn }),
    );
    expect(await importRow(viaConn)).toEqual(
      expect.objectContaining({ state: "failed", error_code: "connection_unavailable" }),
    );
  });

  it("el import de otra marca no se toca aunque el job lo pida", async () => {
    const other = await seedCompany(handle);
    const id = await newImport({
      source: "profile",
      platform: "tiktok",
      profileUrl: "https://www.tiktok.com/@acme",
    });
    const downloader = new FakeDownloader();
    await createOwnPostImportHandler({
      db: handle.db,
      storage: new MemoryStorage(clock),
      queue: new RecordingQueue(),
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
      tokens: null,
      downloader,
      profiles: new FakeLister(),
    })(ctx({ companyId: other, importId: id }));
    expect(downloader.urls).toHaveLength(0);
    expect((await importRow(id))?.state).toBe("queued");
  });
});
