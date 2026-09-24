/**
 * YouTube Shorts y LinkedIn por el handler de publicación, contra Postgres —
 * `PU-LATER-001`, `PU-LATER-002`.
 *
 * A diferencia de `publishing-sprint3.int.test.ts`, acá corren los
 * **publicadores reales** (`@fastgram/adapters/publishers`) con un `fetch`
 * falso que contesta lo que documenta cada plataforma (las URLs están en la
 * cabecera de cada adaptador). Nada habla con Google ni con LinkedIn. Lo que
 * se fija es el cableado que sólo existe en el worker:
 *
 *  - el `canvas` del payload de build llega al publicador como ancho/alto del
 *    render, y YouTube se niega a subir algo que no es un Short sin gastar
 *    cuota;
 *  - la guarda de cuota de instalación (100 subidas por día del Pacífico,
 *    sumando **todas** las marcas) reprograma en vez de publicar;
 *  - un 401 de YouTube deja el post en `AWAITING_RECONNECT`;
 *  - LinkedIn publica como la Página (`platformUserId` = URN de organización)
 *    y guarda el permalink documentado.
 */
import { randomUUID } from "node:crypto";

import { FixedClock } from "@fastgram/adapters";
import {
  LinkedInPublisher,
  YouTubeShortsPublisher,
  type PublisherFetch,
} from "@fastgram/adapters/publishers";
import { JOB_QUEUES } from "@fastgram/core";
import { APP_ROLE, type DbHandle } from "@fastgram/db";
import type {
  ConnectionTokens,
  EnqueuedJob,
  JobContext,
  JobSpec,
  Queue,
} from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createPublishHandler } from "../src/publishing/publish-handler.js";
import { openDb, seedCompany, seedPost } from "./helpers/fixtures.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const HOUR = 3_600_000;
const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

let handle: DbHandle;

/* ------------------------------------------------------------------------ *
 * Dobles
 * ------------------------------------------------------------------------ */

class GrabadoraQueue implements Queue {
  readonly jobs: JobSpec<unknown>[] = [];
  async enqueue<T>(job: JobSpec<T>): Promise<EnqueuedJob> {
    this.jobs.push(job as JobSpec<unknown>);
    return { jobId: randomUUID(), created: true };
  }
  async enqueueMany(jobs: readonly JobSpec<unknown>[]): Promise<readonly EnqueuedJob[]> {
    return Promise.all(jobs.map((j) => this.enqueue(j)));
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
  en(queue: string): JobSpec<unknown>[] {
    return this.jobs.filter((j) => j.queue === queue);
  }
}

const tokens: ConnectionTokens = {
  getAccessToken: () => Promise.resolve("token-en-claro"),
};

interface Llamada {
  readonly method: string;
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

/** Rutas → respuestas, por método + substring de la URL. La primera que matchea. */
function fetchFalso(
  rutas: readonly {
    method: string;
    match: string;
    reply: () => Response;
  }[],
): { fetch: PublisherFetch; llamadas: Llamada[] } {
  const llamadas: Llamada[] = [];
  const fetch: PublisherFetch = (url, init) => {
    llamadas.push({ method: init.method, url, headers: init.headers, body: init.body });
    const ruta = rutas.find((r) => r.method === init.method && url.includes(r.match));
    if (ruta === undefined) throw new Error(`ruta no declarada: ${init.method} ${url}`);
    return Promise.resolve(ruta.reply());
  };
  return { fetch, llamadas };
}

/** MP4 mínimo (`ftyp` + `moov{mvhd,trak{tkhd}}` + `mdat`), como en los tests del adaptador. */
function mp4(seconds: number, width: number, height: number, padding = 1024): Uint8Array {
  const box = (type: string, content: Uint8Array) => {
    const out = new Uint8Array(8 + content.byteLength);
    new DataView(out.buffer).setUint32(0, out.byteLength);
    for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
    out.set(content, 8);
    return out;
  };
  const cat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
    let o = 0;
    for (const p of parts) {
      out.set(p, o);
      o += p.byteLength;
    }
    return out;
  };
  const mvhd = new Uint8Array(100);
  new DataView(mvhd.buffer).setUint32(12, 1000);
  new DataView(mvhd.buffer).setUint32(16, seconds * 1000);
  const tkhd = new Uint8Array(84);
  new DataView(tkhd.buffer).setUint32(76, width * 65536);
  new DataView(tkhd.buffer).setUint32(80, height * 65536);
  return cat(
    box("ftyp", new TextEncoder().encode("isomisom")),
    box("moov", cat(box("mvhd", mvhd), box("trak", box("tkhd", tkhd)))),
    box("mdat", new Uint8Array(padding)),
  );
}

const ctx = (payload: unknown): JobContext<unknown> => ({
  jobId: `job-${randomUUID()}`,
  payload,
  attempt: 1,
  maxAttempts: 1,
});

let queue: GrabadoraQueue;

beforeAll(() => {
  handle = openDb();
});

afterAll(async () => {
  await handle?.close();
});

beforeEach(() => {
  queue = new GrabadoraQueue();
});

function handlerCon(publishers: Record<string, unknown>) {
  return createPublishHandler({
    db: handle.db,
    publishers: publishers as never,
    clock: new FixedClock(NOW),
    appRole: APP_ROLE,
    logger: silencioso,
    queue,
    tokens,
  });
}

/** Un post de YouTube/LinkedIn con el canvas del render en el payload de build. */
async function seedRed(
  companyId: string,
  platform: "youtube" | "linkedin",
  canvas: { width: number; height: number },
  platformUserId?: string,
) {
  const seeded = await seedPost(handle, companyId, {
    platform: "youtube",
    caption: platform === "youtube" ? "Un Short" : "Hola #marca",
  });
  await handle.sql`
    update contents set build_payload = ${JSON.stringify({ canvas })}::jsonb
    where id = ${seeded.contentId}::uuid`;
  if (platform === "linkedin") {
    await handle.sql`update connections set platform = 'linkedin', platform_user_id = ${platformUserId ?? "urn:li:person:x"} where id = ${seeded.connectionId}::uuid`;
    await handle.sql`update posts set platform = 'linkedin' where id = ${seeded.postId}::uuid`;
  }
  return seeded;
}

async function fila(postId: string) {
  const [row] = await handle.sql`
    select status, external_post_id, error_code, error_message, post_url, scheduled_at_utc
    from posts where id = ${postId}::uuid`;
  return row as {
    status: string;
    external_post_id: string | null;
    error_code: string | null;
    error_message: string | null;
    post_url: string | null;
    scheduled_at_utc: Date | string;
  };
}

const SESSION = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc";

function youtubeFetch(
  file: Uint8Array,
  init: () => Response = () =>
    new Response(null, { status: 200, headers: { location: SESSION } }),
) {
  return fetchFalso([
    {
      method: "GET",
      match: "cdn.example.test",
      reply: () =>
        new Response(file, { status: 200, headers: { "content-type": "video/mp4" } }),
    },
    { method: "POST", match: "uploadType=resumable", reply: init },
    {
      method: "PUT",
      match: "upload_id=abc",
      reply: () =>
        Response.json(
          { id: "vid-123", status: { uploadStatus: "uploaded" } },
          { status: 201 },
        ),
    },
  ]);
}

describe("YouTube Shorts por el handler", () => {
  it("vertical: sube, queda procesando con el id del video y arma el watcher", async () => {
    const companyId = await seedCompany(handle);
    const { postId } = await seedRed(companyId, "youtube", { width: 1080, height: 1920 });
    const { fetch, llamadas } = youtubeFetch(mp4(30, 1080, 1920));

    await handlerCon({ youtube: new YouTubeShortsPublisher({ fetch }) })(
      ctx({ companyId, postId }),
    );

    const row = await fila(postId);
    expect(row).toMatchObject({
      status: "UPLOADING_TO_TIKTOK",
      external_post_id: "vid-123",
    });
    const init = llamadas.find((l) => l.url.includes("uploadType=resumable"));
    expect(JSON.parse(init?.body as string)).toMatchObject({
      snippet: { title: "Un Short" },
      status: { privacyStatus: "public" },
    });
    expect(init?.headers["Authorization"]).toBe("Bearer token-en-claro");
    expect(queue.en(JOB_QUEUES.tiktokSlowLaneWatcher)).toHaveLength(1);
  });

  it("el canvas del render manda: 16:9 no se sube aunque el archivo diga vertical", async () => {
    const companyId = await seedCompany(handle);
    const { postId } = await seedRed(companyId, "youtube", { width: 1920, height: 1080 });
    const { fetch, llamadas } = youtubeFetch(mp4(30, 1080, 1920));

    await handlerCon({ youtube: new YouTubeShortsPublisher({ fetch }) })(
      ctx({ companyId, postId }),
    );

    const row = await fila(postId);
    expect(row.status).toBe("FAILED");
    expect(row.error_message).toContain("vertical or square");
    expect(llamadas.some((l) => l.url.includes("uploadType=resumable"))).toBe(false);
  });

  it("401 de YouTube: AWAITING_RECONNECT, no FAILED", async () => {
    const companyId = await seedCompany(handle);
    const { postId } = await seedRed(companyId, "youtube", { width: 1080, height: 1920 });
    const { fetch } = youtubeFetch(mp4(30, 1080, 1920), () =>
      Response.json(
        { error: { code: 401, errors: [{ reason: "authError" }] } },
        { status: 401 },
      ),
    );

    await handlerCon({ youtube: new YouTubeShortsPublisher({ fetch }) })(
      ctx({ companyId, postId }),
    );

    expect((await fila(postId)).status).toBe("AWAITING_RECONNECT");
  });

  it("cuota de instalación: con 100 subidas hoy en otra marca, reprograma sin llamar", async () => {
    const companyId = await seedCompany(handle);
    const { postId } = await seedRed(companyId, "youtube", { width: 1080, height: 1920 });

    // Una marca hermana del mismo dueño con 100 Shorts ya subidos hoy.
    const [hermana] = await handle.sql`
      insert into companies (name, owner_user_id, status, plan_id, billing_anchor_day, timezone)
      select ${`hermana-${randomUUID()}`}, owner_user_id, 'active', 'growth', 1, 'UTC'
      from companies where id = ${companyId}::uuid
      returning id`;
    const hermanaId = hermana?.["id"] as string;
    const base = await seedPost(handle, hermanaId, { platform: "youtube" });
    await handle.sql`
      insert into posts (company_id, content_id, platform, account_type, connection_id,
                         scheduled_at_utc, posted_at, caption, status)
      select ${hermanaId}::uuid, ${base.contentId}::uuid, 'youtube', 'oauth',
             ${base.connectionId}::uuid,
             ${new Date(NOW.getTime() - 2 * HOUR).toISOString()}::timestamptz,
             ${new Date(NOW.getTime() - HOUR).toISOString()}::timestamptz,
             'ya subido', 'POSTED'
      from generate_series(1, 100)`;

    const { fetch, llamadas } = youtubeFetch(mp4(30, 1080, 1920));
    await handlerCon({ youtube: new YouTubeShortsPublisher({ fetch }) })(
      ctx({ companyId, postId }),
    );

    expect(llamadas).toHaveLength(0);
    const row = await fila(postId);
    expect(row.status).toBe("SCHEDULED");
    // Al día siguiente (del Pacífico), a la misma hora.
    expect(new Date(row.scheduled_at_utc).getTime()).toBe(NOW.getTime() + 24 * HOUR);
    expect(queue.en(JOB_QUEUES.publishing)).toHaveLength(1);
  });
});

describe("LinkedIn por el handler", () => {
  it("publica como la Página con video y guarda el permalink", async () => {
    const companyId = await seedCompany(handle);
    const org = "urn:li:organization:2414183";
    const { postId } = await seedRed(
      companyId,
      "linkedin",
      { width: 1080, height: 1920 },
      org,
    );
    const video = "urn:li:video:C5505AQH";
    const postUrn = "urn:li:share:6844785523593134080";
    const { fetch, llamadas } = fetchFalso([
      {
        method: "GET",
        match: "cdn.example.test",
        reply: () => new Response(new Uint8Array(100 * 1024), { status: 200 }),
      },
      {
        method: "POST",
        match: "/rest/videos?action=initializeUpload",
        reply: () =>
          Response.json({
            value: {
              video,
              uploadToken: "",
              uploadInstructions: [
                {
                  uploadUrl: "https://www.linkedin.com/dms-uploads/p1",
                  firstByte: 0,
                  lastByte: 100 * 1024 - 1,
                },
              ],
            },
          }),
      },
      {
        method: "PUT",
        match: "dms-uploads/p1",
        reply: () => new Response(null, { status: 200, headers: { etag: "e1" } }),
      },
      {
        method: "POST",
        match: "/rest/videos?action=finalizeUpload",
        reply: () => new Response(null, { status: 200 }),
      },
      {
        method: "GET",
        match: "/rest/videos/",
        reply: () => Response.json({ id: video, status: "AVAILABLE" }),
      },
      {
        method: "POST",
        match: "/rest/posts",
        reply: () =>
          new Response(null, { status: 201, headers: { "x-restli-id": postUrn } }),
      },
    ]);

    await handlerCon({
      linkedin: new LinkedInPublisher({ fetch, sleep: () => Promise.resolve() }),
    })(ctx({ companyId, postId }));

    const row = await fila(postId);
    expect(row).toMatchObject({
      status: "POSTED",
      external_post_id: postUrn,
      post_url: `https://www.linkedin.com/feed/update/${postUrn}/`,
    });
    const create = llamadas.find(
      (l) => l.method === "POST" && l.url.endsWith("/rest/posts"),
    );
    expect(JSON.parse(create?.body as string)).toMatchObject({
      author: org,
      commentary: "Hola \\#marca",
      content: { media: { id: video } },
    });
    expect(create?.headers["LinkedIn-Version"]).toBe("202609");
  });
});
