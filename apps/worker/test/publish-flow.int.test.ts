/**
 * Sprint 7 — publish-flow en el worker, contra Postgres real.
 *
 *  - el barrido convierte un slot **plano** (auto-slot / piloto) con la caption
 *    derivada de la pieza, ya no vacía;
 *  - el publicador deriva la caption de un post con `caption = null` y respeta
 *    un `""` explícito;
 *  - `P3-PUB-006`: un fallo no mapeado queda como `publish_failed` con nuestro
 *    mensaje, nunca el crudo;
 *  - `F-158` para OAuth: un slideshow de Instagram con formato `reel` sale como
 *    video compuesto; sin compositor, `slideshow_reel_unavailable`; `carousel`
 *    sale como slideshow.
 */
import { randomUUID } from "node:crypto";

import { FixedClock } from "@fastgram/adapters";
import {
  JOB_QUEUES,
  PUBLISH_GENERIC_ERROR_CODE,
  PUBLISH_GENERIC_ERROR_MESSAGE,
  deriveCaption,
} from "@fastgram/core";
import { APP_ROLE, plannedSlots, withoutCompany, type DbHandle } from "@fastgram/db";
import type {
  EnqueuedJob,
  JobContext,
  JobSpec,
  PublishRequest,
  PublishStatus,
  Queue,
  SocialPublishCapabilities,
  SocialPublisher,
} from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createPublishHandler } from "../src/publishing/publish-handler.js";
import type { SlideshowReelComposer } from "../src/publishing/slideshow-reel.js";
import { createPublishingSweepHandler } from "../src/publishing/sweep-handler.js";
import { openDb, readPost, seedCompany, seedPost } from "./helpers/fixtures.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const HOUR = 3_600_000;
const COPY = "3 errores al hacer café.\n\nMirá https://ejemplo.com\n\nSeguinos #cafe";
/** Lo que `deriveCaption` hace con COPY en Instagram: la tira final de hashtags va en su línea. */
const IG_CAPTION =
  "3 errores al hacer café.\n\nMirá https://ejemplo.com\n\nSeguinos\n\n#cafe";
const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

let handle: DbHandle;
let clock: FixedClock;

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
}

const caps = (
  platform: SocialPublishCapabilities["platform"],
): SocialPublishCapabilities => ({
  platform,
  provider: "falso",
  accountTypes: ["oauth"],
  mediaKinds: ["video", "slideshow", "carousel", "image"],
  captionLimits: { caption: 2200 },
  postingModes: [],
  privacyLevels: [],
  supportsAiLabel: false,
  supportsPartnershipDisclosure: false,
  supportsAutoAddMusic: false,
  supportsCaptionGeneration: false,
  supportsNativeScheduling: false,
  requiredAccountKinds: [],
});

class PublicadorFalso implements SocialPublisher {
  readonly pedidos: PublishRequest[] = [];
  siguiente: PublishStatus | null = null;
  constructor(readonly platform: SocialPublishCapabilities["platform"]) {}
  capabilities() {
    return caps(this.platform);
  }
  async getAccountOptions() {
    return { allowedPrivacyLevels: [], directPostingAvailable: false };
  }
  async publish(request: PublishRequest): Promise<PublishStatus> {
    this.pedidos.push(request);
    return (
      this.siguiente ?? {
        kind: "published",
        externalPostId: "ext-1",
        permalink: "https://plataforma.test/p/1",
      }
    );
  }
  async getStatus() {
    return null;
  }
  async cancel() {
    return { cancelled: false, pending: false };
  }
  async fetchMetrics() {
    return [];
  }
}

const ctx = (payload: unknown): JobContext<unknown> => ({
  jobId: `job-${randomUUID()}`,
  payload,
  attempt: 1,
  maxAttempts: 1,
});

async function setCopy(contentId: string, text: string): Promise<void> {
  await handle.sql`update contents set generated_text = ${text} where id = ${contentId}::uuid`;
}

async function setCaption(postId: string, caption: string | null): Promise<void> {
  await handle.sql`update posts set caption = ${caption} where id = ${postId}::uuid`;
}

let queue: GrabadoraQueue;

beforeAll(() => {
  handle = openDb();
});

afterAll(async () => {
  await handle?.close();
});

beforeEach(() => {
  clock = new FixedClock(NOW);
  queue = new GrabadoraQueue();
});

describe("barrido: un slot plano ya no sale sin caption", () => {
  it("el post convertido lleva la caption derivada de la pieza", async () => {
    const companyId = await seedCompany(handle);
    const { contentId } = await seedPost(handle, companyId, { platform: "instagram" });
    await setCopy(contentId, COPY);
    const at = new Date(NOW.getTime() + 2 * HOUR);
    await withoutCompany(handle.db, (tx) =>
      tx.insert(plannedSlots).values({
        companyId,
        contentId,
        network: "instagram",
        scheduledAtUtc: at,
      }),
    );

    await createPublishingSweepHandler({
      db: handle.db,
      queue,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
      postableNetworks: ["instagram"],
    })(ctx({ companyId }));

    const [job] = queue.jobs.filter((j) => j.queue === JOB_QUEUES.publishing);
    const postId = (job?.payload as { postId: string }).postId;
    const [row] = await handle.sql`select caption from posts where id = ${postId}::uuid`;
    expect(row?.["caption"]).toBe(IG_CAPTION);
    expect(deriveCaption("instagram", { generatedText: COPY })?.caption).toBe(IG_CAPTION);
  });
});

describe("publicador: caption derivada, fallback de errores y reel", () => {
  const handler = (
    publishers: Record<string, SocialPublisher>,
    slideshowReels?: SlideshowReelComposer | null,
  ) =>
    createPublishHandler({
      db: handle.db,
      publishers,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
      guards: false,
      ...(slideshowReels === undefined ? {} : { slideshowReels }),
    });

  it("caption null → derivada; '' → vacía a propósito", async () => {
    const companyId = await seedCompany(handle);
    const ig = new PublicadorFalso("instagram");
    const a = await seedPost(handle, companyId, { platform: "instagram" });
    await setCopy(a.contentId, COPY);
    await setCaption(a.postId, null);
    await handler({ instagram: ig })(ctx({ companyId, postId: a.postId }));
    expect(ig.pedidos[0]?.caption).toBe(IG_CAPTION);

    const companyB = await seedCompany(handle);
    const b = await seedPost(handle, companyB, { platform: "instagram" });
    await setCopy(b.contentId, COPY);
    await setCaption(b.postId, "");
    await handler({ instagram: ig })(ctx({ companyId: companyB, postId: b.postId }));
    expect(ig.pedidos[1]?.caption).toBe("");
  });

  it("P3-PUB-006: un fallo no mapeado queda publish_failed, sin el mensaje crudo", async () => {
    const companyId = await seedCompany(handle);
    const tt = new PublicadorFalso("tiktok");
    tt.siguiente = {
      kind: "failed",
      failure: { reason: "unknown", message: "RAW provider error (#9007) trace" },
    };
    const { postId } = await seedPost(handle, companyId);
    await handler({ tiktok: tt })(ctx({ companyId, postId }));
    const row = await readPost(handle, postId);
    expect(row.status).toBe("FAILED");
    expect(row.error_code).toBe(PUBLISH_GENERIC_ERROR_CODE);
    expect(row.error_message).toBe(PUBLISH_GENERIC_ERROR_MESSAGE);
  });

  const seedSlideshow = async (format: "reel" | "carousel") => {
    const companyId = await seedCompany(handle);
    const seeded = await seedPost(handle, companyId, {
      platform: "instagram",
      contentType: "slideshow",
      files: ["https://cdn.example.test/s0.png", "https://cdn.example.test/s1.png"],
    });
    await handle.sql`
      update posts set instagram_slideshow_format = ${format}
      where id = ${seeded.postId}::uuid`;
    return { companyId, ...seeded };
  };

  it("reel: el slideshow sale como video compuesto", async () => {
    const { companyId, postId, contentId } = await seedSlideshow("reel");
    const ig = new PublicadorFalso("instagram");
    const compuestos: string[] = [];
    const composer: SlideshowReelComposer = {
      async compose(input) {
        compuestos.push(input.contentId);
        expect(input.files).toHaveLength(2);
        return "https://cdn.example.test/reel.mp4";
      },
    };
    await handler({ instagram: ig }, composer)(ctx({ companyId, postId }));
    expect(compuestos).toEqual([contentId]);
    expect(ig.pedidos[0]?.media).toMatchObject({
      kind: "video",
      urls: ["https://cdn.example.test/reel.mp4"],
      width: 1080,
      height: 1920,
    });
    expect((await readPost(handle, postId)).status).toBe("POSTED");
  });

  it("reel sin compositor → FAILED slideshow_reel_unavailable, sin publicar", async () => {
    const { companyId, postId } = await seedSlideshow("reel");
    const ig = new PublicadorFalso("instagram");
    await handler({ instagram: ig }, null)(ctx({ companyId, postId }));
    expect(ig.pedidos).toHaveLength(0);
    const row = await readPost(handle, postId);
    expect(row).toMatchObject({
      status: "FAILED",
      error_code: "slideshow_reel_unavailable",
    });
  });

  it("carousel: sale como slideshow con las slides", async () => {
    const { companyId, postId } = await seedSlideshow("carousel");
    const ig = new PublicadorFalso("instagram");
    await handler({ instagram: ig }, null)(ctx({ companyId, postId }));
    expect(ig.pedidos[0]?.media.kind).toBe("slideshow");
    expect(ig.pedidos[0]?.media.urls).toHaveLength(2);
  });
});
