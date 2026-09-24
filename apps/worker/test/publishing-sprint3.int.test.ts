/**
 * El lado de publicación del sprint 3, contra Postgres — `PU-PUB-006/007/008`,
 * `P3-PUB-002`, `P3-PUB-004`, `FR-060`, `NFR-015`.
 *
 * Con un publicador **falso** (nada habla con una plataforma) y una cola que
 * **graba** lo encolado, para poder afirmar sobre los jobs nuevos: la
 * reprogramación de las guardas, los reintentos, el watcher y el barrido.
 *
 * Corre con `SET LOCAL ROLE fastgram_app`, igual que `publish.int.test.ts`.
 * La lista de marcas del dueño corre con la conexión de desarrollo
 * (superusuaria), como en la API.
 */
import { randomUUID } from "node:crypto";

import { FixedClock } from "@fastgram/adapters";
import { JOB_QUEUES } from "@fastgram/core";
import { APP_ROLE, plannedSlots, withoutCompany, type DbHandle } from "@fastgram/db";
import {
  PortError,
  PublishDeliveryUncertainError,
  type ConnectionTokens,
  type EnqueuedJob,
  type JobContext,
  type JobSpec,
  type PublishRequest,
  type PublishStatus,
  type Queue,
  type SocialPublishCapabilities,
  type SocialPublisher,
} from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import type { ContentFingerprinter } from "../src/publishing/fingerprint.js";
import { createPublishHandler } from "../src/publishing/publish-handler.js";
import { createPublishingSweepHandler } from "../src/publishing/sweep-handler.js";
import { createWatchHandler } from "../src/publishing/watch-handler.js";
import { openDb, readPost, seedCompany, seedPost } from "./helpers/fixtures.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

let handle: DbHandle;
let clock: FixedClock;

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

const CAPS: SocialPublishCapabilities = {
  platform: "tiktok",
  provider: "falso",
  accountTypes: ["oauth"],
  mediaKinds: ["video", "slideshow"],
  captionLimits: { caption: 2200 },
  postingModes: ["inbox"],
  privacyLevels: [],
  supportsAiLabel: false,
  supportsPartnershipDisclosure: false,
  supportsAutoAddMusic: false,
  supportsCaptionGeneration: false,
  supportsNativeScheduling: false,
  requiredAccountKinds: [],
};

class PublicadorFalso implements SocialPublisher {
  readonly pedidos: PublishRequest[] = [];
  resultados: (PublishStatus | Error)[] = [];
  estado: PublishStatus | null = null;
  capabilities() {
    return CAPS;
  }
  async getAccountOptions() {
    return { allowedPrivacyLevels: [], directPostingAvailable: false };
  }
  async publish(request: PublishRequest): Promise<PublishStatus> {
    this.pedidos.push(request);
    const next = this.resultados.shift() ?? {
      kind: "published" as const,
      externalPostId: `ext-${String(this.pedidos.length)}`,
      permalink: "https://plataforma.test/p/1",
    };
    if (next instanceof Error) throw next;
    return next;
  }
  async getStatus() {
    return this.estado;
  }
  async cancel() {
    return { cancelled: false, pending: false };
  }
  async fetchMetrics() {
    return [];
  }
}

class TokensFalsos implements ConnectionTokens {
  error: Error | null = null;
  pedidos: { connectionId: string; companyId: string }[] = [];
  async getAccessToken(
    connectionId: string,
    scope: { companyId: string },
  ): Promise<string> {
    this.pedidos.push({ connectionId, companyId: scope.companyId });
    if (this.error !== null) throw this.error;
    return "token-en-claro";
  }
}

let publicador: PublicadorFalso;
let queue: GrabadoraQueue;
let tokens: TokensFalsos;

const handler = (
  over: { fingerprinter?: ContentFingerprinter | null; guards?: boolean } = {},
) =>
  createPublishHandler({
    db: handle.db,
    publishers: { tiktok: publicador },
    clock,
    appRole: APP_ROLE,
    logger: silencioso,
    queue,
    tokens,
    ...over,
  });

const ctx = (payload: unknown): JobContext<unknown> => ({
  jobId: `job-${randomUUID()}`,
  payload,
  attempt: 1,
  maxAttempts: 1,
});

/* ------------------------------------------------------------------------ *
 * Fixtures propias
 * ------------------------------------------------------------------------ */

/** Otra marca del mismo dueño (`D-07`: una marca = una company). */
async function seedSiblingBrand(companyId: string): Promise<string> {
  const [row] = await handle.sql`
    insert into companies (name, owner_user_id, status, plan_id, billing_anchor_day, timezone)
    select ${`hermana-${randomUUID()}`}, owner_user_id, 'active', 'growth', 1, 'UTC'
    from companies where id = ${companyId}::uuid
    returning id`;
  const id = row?.["id"];
  if (typeof id !== "string") throw new Error("no se creó la marca hermana");
  return id;
}

/**
 * Escribe columnas crudas. Las fechas van como ISO con `::timestamptz`: el
 * cliente crudo tiene serializadores identidad (trampa 18) y no acepta `Date`.
 */
async function setPost(
  postId: string,
  fields: { status?: string; posted_at?: Date; scheduled_at_utc?: Date },
): Promise<void> {
  if (fields.status !== undefined) {
    await handle.sql`update posts set status = ${fields.status}::post_status where id = ${postId}::uuid`;
  }
  if (fields.posted_at !== undefined) {
    await handle.sql`update posts set posted_at = ${fields.posted_at.toISOString()}::timestamptz where id = ${postId}::uuid`;
  }
  if (fields.scheduled_at_utc !== undefined) {
    await handle.sql`update posts set scheduled_at_utc = ${fields.scheduled_at_utc.toISOString()}::timestamptz where id = ${postId}::uuid`;
  }
}

async function setConnectionStatus(connectionId: string, status: string): Promise<void> {
  await handle.sql`update connections set status = ${status}::connection_status where id = ${connectionId}::uuid`;
}

async function readRaw(postId: string) {
  const [row] = await handle.sql`
    select status, scheduled_at_utc, external_post_id, error_code, posted_at
    from posts where id = ${postId}::uuid`;
  const raw = row as {
    status: string;
    scheduled_at_utc: string | Date;
    external_post_id: string | null;
    error_code: string | null;
    posted_at: string | Date | null;
  };
  return {
    ...raw,
    scheduled_at_utc: new Date(raw.scheduled_at_utc),
    posted_at: raw.posted_at === null ? null : new Date(raw.posted_at),
  };
}

beforeAll(async () => {
  handle = openDb();
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(() => {
  clock = new FixedClock(NOW);
  publicador = new PublicadorFalso();
  queue = new GrabadoraQueue();
  tokens = new TokensFalsos();
});

/* ------------------------------------------------------------------------ */

describe("hora futura — mover un post es cambiar la hora", () => {
  it("un post cuya hora todavía no llegó se saltea sin publicar", async () => {
    const companyId = await seedCompany(handle);
    const { postId } = await seedPost(handle, companyId);
    await setPost(postId, { scheduled_at_utc: new Date(NOW.getTime() + HOUR) });

    await handler()(ctx({ companyId, postId }));

    expect(publicador.pedidos).toHaveLength(0);
    expect((await readRaw(postId)).status).toBe("SCHEDULED");
  });
});

describe("el camino feliz con token y externalPostId", () => {
  it("pide el token con el scope de la marca, publica y guarda el id externo", async () => {
    const companyId = await seedCompany(handle);
    const { postId, connectionId } = await seedPost(handle, companyId);

    await handler()(ctx({ companyId, postId }));

    expect(tokens.pedidos).toEqual([{ connectionId, companyId }]);
    expect(publicador.pedidos[0]?.account.accessToken).toBe("token-en-claro");
    expect(publicador.pedidos[0]?.account.platformUserId).toMatch(/^tt-/);
    const row = await readRaw(postId);
    expect(row.status).toBe("POSTED");
    expect(row.external_post_id).toBe("ext-1");
  });
});

describe("AWAITING_RECONNECT — P3-PUB-002", () => {
  it("conexión expirada: no publica, queda AWAITING_RECONNECT y arma el barrido", async () => {
    const companyId = await seedCompany(handle);
    const { postId, connectionId } = await seedPost(handle, companyId);
    await setConnectionStatus(connectionId, "expired");

    await handler()(ctx({ companyId, postId }));

    expect(publicador.pedidos).toHaveLength(0);
    expect((await readPost(handle, postId)).status).toBe("AWAITING_RECONNECT");
    expect(queue.en(JOB_QUEUES.publishingSweep)).toHaveLength(1);
  });

  it("token rechazado (unauthorized): también AWAITING_RECONNECT, sin publicar", async () => {
    const companyId = await seedCompany(handle);
    const { postId } = await seedPost(handle, companyId);
    tokens.error = new PortError("unauthorized", "reconectar", { source: "t" });

    await handler()(ctx({ companyId, postId }));

    expect(publicador.pedidos).toHaveLength(0);
    expect((await readPost(handle, postId)).status).toBe("AWAITING_RECONNECT");
  });

  it("al reconectar, el barrido lo reanuda y el job nuevo lo publica", async () => {
    const companyId = await seedCompany(handle);
    const { postId, connectionId } = await seedPost(handle, companyId);
    await setConnectionStatus(connectionId, "expired");
    await handler()(ctx({ companyId, postId }));

    const sweep = createPublishingSweepHandler({
      db: handle.db,
      queue,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
    });

    // Sin reconectar: sigue esperando y el barrido se vuelve a armar.
    queue.jobs.length = 0;
    await sweep(ctx({ companyId }));
    expect((await readRaw(postId)).status).toBe("AWAITING_RECONNECT");
    expect(queue.en(JOB_QUEUES.publishingSweep)).toHaveLength(1);

    // Reconecta (la misma fila vuelve a `active`).
    queue.jobs.length = 0;
    await setConnectionStatus(connectionId, "active");
    await sweep(ctx({ companyId }));

    const row = await readRaw(postId);
    expect(row.status).toBe("SCHEDULED");
    // La hora pasó (10:00 < 12:00): se reanuda a un minuto de ahora.
    expect(row.scheduled_at_utc.getTime()).toBe(NOW.getTime() + MIN);
    const [job] = queue.en(JOB_QUEUES.publishing);
    expect(job?.payload).toEqual({ companyId, postId });
    expect(job?.options?.singletonKey).toBe(
      `publishing:${postId}:resume:${String(NOW.getTime() + MIN)}`,
    );
    // Ya no hay nada esperando: no se re-arma.
    expect(queue.en(JOB_QUEUES.publishingSweep)).toHaveLength(0);

    clock.advanceMs(MIN);
    await handler()(ctx(job?.payload));
    expect((await readRaw(postId)).status).toBe("POSTED");
  });

  it("pasado el margen de 24 h, FAILED con awaiting_reconnect_expired", async () => {
    const companyId = await seedCompany(handle);
    const { postId, connectionId } = await seedPost(handle, companyId);
    await setConnectionStatus(connectionId, "expired");
    await handler()(ctx({ companyId, postId }));

    clock.advanceHours(25);
    await createPublishingSweepHandler({
      db: handle.db,
      queue,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
    })(ctx({ companyId }));

    const row = await readRaw(postId);
    expect(row.status).toBe("FAILED");
    expect(row.error_code).toBe("awaiting_reconnect_expired");
  });
});

describe("reintentos sólo de lo que no llegó — PU-PUB-008", () => {
  it("un transitorio antes de entregar encola un reintento y el post sigue SCHEDULED", async () => {
    const companyId = await seedCompany(handle);
    const { postId } = await seedPost(handle, companyId);
    publicador.resultados = [
      new PortError("provider_unavailable", "5xx creando el contenedor", { source: "t" }),
    ];

    await handler()(ctx({ companyId, postId }));

    expect((await readRaw(postId)).status).toBe("SCHEDULED");
    const [retry] = queue.en(JOB_QUEUES.publishing);
    expect(retry?.payload).toEqual({ companyId, postId, retry: 1 });
    expect(retry?.options?.startAfter?.getTime()).toBe(NOW.getTime() + MIN);
    expect(retry?.options?.retryLimit).toBe(0);
  });

  it("agotados los tres reintentos, FAILED con el código neutral", async () => {
    const companyId = await seedCompany(handle);
    const { postId } = await seedPost(handle, companyId);
    publicador.resultados = [new PortError("timeout", "lento", { source: "t" })];

    await handler()(ctx({ companyId, postId, retry: 3 }));

    const row = await readRaw(postId);
    expect(row.status).toBe("FAILED");
    expect(row.error_code).toBe("timeout");
    expect(queue.en(JOB_QUEUES.publishing)).toHaveLength(0);
  });

  it("entrega incierta: FAILED con delivery_unconfirmed y NINGÚN reintento", async () => {
    const companyId = await seedCompany(handle);
    const { postId } = await seedPost(handle, companyId);
    publicador.resultados = [
      new PublishDeliveryUncertainError("provider_unavailable", "5xx publicando", {
        source: "t",
      }),
    ];

    await handler()(ctx({ companyId, postId }));

    const row = await readRaw(postId);
    expect(row.status).toBe("FAILED");
    expect(row.error_code).toBe("delivery_unconfirmed");
    expect(queue.en(JOB_QUEUES.publishing)).toHaveLength(0);
    expect(publicador.pedidos).toHaveLength(1);
  });
});

describe("guardas anti-bot — PU-PUB-007", () => {
  it("tope de 3 por red y día: el cuarto se reprograma a mañana a la misma hora", async () => {
    const companyId = await seedCompany(handle);
    for (let i = 1; i <= 3; i += 1) {
      const { postId } = await seedPost(handle, companyId);
      await setPost(postId, {
        status: "POSTED",
        posted_at: new Date(NOW.getTime() - i * HOUR),
      });
    }
    const { postId } = await seedPost(handle, companyId);

    await handler()(ctx({ companyId, postId }));

    expect(publicador.pedidos).toHaveLength(0);
    const row = await readRaw(postId);
    expect(row.status).toBe("SCHEDULED");
    const manana = NOW.getTime() + 24 * HOUR;
    expect(row.scheduled_at_utc.getTime()).toBe(manana);
    const [job] = queue.en(JOB_QUEUES.publishing);
    expect(job?.options?.startAfter?.getTime()).toBe(manana);
    expect(job?.options?.singletonKey).toBe(`publishing:${postId}:at:${String(manana)}`);

    // Mañana, el job nuevo publica.
    clock.advanceHours(24);
    await handler()(ctx(job?.payload));
    expect((await readRaw(postId)).status).toBe("POSTED");
  });

  it("separación entre marcas: otra marca del dueño publicó hace 4 min → espera 6", async () => {
    const companyId = await seedCompany(handle);
    const hermana = await seedSiblingBrand(companyId);
    const { postId: otro } = await seedPost(handle, hermana);
    await setPost(otro, {
      status: "POSTED",
      posted_at: new Date(NOW.getTime() - 4 * MIN),
    });
    const { postId } = await seedPost(handle, companyId);

    await handler()(ctx({ companyId, postId }));

    expect(publicador.pedidos).toHaveLength(0);
    expect((await readRaw(postId)).scheduled_at_utc.getTime()).toBe(
      NOW.getTime() + 6 * MIN,
    );
  });

  it("la misma pieza ya publicada por otra marca → FAILED duplicate_across_brands", async () => {
    const companyId = await seedCompany(handle);
    const hermana = await seedSiblingBrand(companyId);
    const { postId: otro } = await seedPost(handle, hermana);
    // Lejos en el tiempo: no es la separación la que frena.
    await setPost(otro, {
      status: "POSTED",
      posted_at: new Date(NOW.getTime() - 10 * 24 * HOUR),
    });
    const { postId } = await seedPost(handle, companyId);
    const mismaHuella: ContentFingerprinter = { of: async () => "huella-igual" };

    await handler({ fingerprinter: mismaHuella })(ctx({ companyId, postId }));

    expect(publicador.pedidos).toHaveLength(0);
    const row = await readRaw(postId);
    expect(row.status).toBe("FAILED");
    expect(row.error_code).toBe("duplicate_across_brands");
  });

  it("huellas distintas no bloquean", async () => {
    const companyId = await seedCompany(handle);
    const hermana = await seedSiblingBrand(companyId);
    const { postId: otro } = await seedPost(handle, hermana);
    await setPost(otro, {
      status: "POSTED",
      posted_at: new Date(NOW.getTime() - 10 * 24 * HOUR),
    });
    const { postId } = await seedPost(handle, companyId);
    let n = 0;
    const distintas: ContentFingerprinter = { of: async () => `h-${String((n += 1))}` };

    await handler({ fingerprinter: distintas })(ctx({ companyId, postId }));

    expect((await readRaw(postId)).status).toBe("POSTED");
  });
});

describe("TikTok inbox y watcher — PU-PUB-006, P3-PUB-004", () => {
  it("in_user_inbox encola el watcher; el watcher ve PUBLISH_COMPLETE → POSTED", async () => {
    const companyId = await seedCompany(handle);
    const { postId } = await seedPost(handle, companyId);
    publicador.resultados = [{ kind: "in_user_inbox", externalPostId: "v_inbox_file~1" }];

    await handler()(ctx({ companyId, postId }));

    let row = await readRaw(postId);
    expect(row.status).toBe("IN_USER_INBOX");
    expect(row.external_post_id).toBe("v_inbox_file~1");
    const [watch] = queue.en(JOB_QUEUES.tiktokSlowLaneWatcher);
    expect(watch?.payload).toEqual({
      companyId,
      postId,
      startedAtMs: NOW.getTime(),
      round: 0,
    });

    const watcher = createWatchHandler({
      db: handle.db,
      publishers: { tiktok: publicador },
      queue,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
      tokens,
    });

    // Todavía en el inbox: sigue mirando, sin fallar.
    queue.jobs.length = 0;
    clock.advanceMs(30 * MIN);
    publicador.estado = { kind: "in_user_inbox", externalPostId: "v_inbox_file~1" };
    await watcher(ctx(watch?.payload));
    expect((await readRaw(postId)).status).toBe("IN_USER_INBOX");
    const [next] = queue.en(JOB_QUEUES.tiktokSlowLaneWatcher);
    expect(next?.payload).toMatchObject({ round: 1 });

    // El creador tocó Post en la app.
    queue.jobs.length = 0;
    publicador.estado = { kind: "published", externalPostId: "v_inbox_file~1" };
    await watcher(ctx(next?.payload));
    row = await readRaw(postId);
    expect(row.status).toBe("POSTED");
    expect(row.posted_at).not.toBeNull();
    expect(queue.en(JOB_QUEUES.tiktokSlowLaneWatcher)).toHaveLength(0);
    // Nunca republicó.
    expect(publicador.pedidos).toHaveLength(1);
  });

  it("72 h procesando: FAILED platform_processing_timeout, sin republicar", async () => {
    const companyId = await seedCompany(handle);
    const { postId } = await seedPost(handle, companyId);
    publicador.resultados = [{ kind: "processing", externalPostId: "p-lento" }];
    await handler()(ctx({ companyId, postId }));
    expect((await readRaw(postId)).status).toBe("UPLOADING_TO_TIKTOK");

    clock.advanceHours(72);
    publicador.estado = { kind: "processing", externalPostId: "p-lento" };
    await createWatchHandler({
      db: handle.db,
      publishers: { tiktok: publicador },
      queue,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
    })(ctx({ companyId, postId, startedAtMs: NOW.getTime(), round: 144 }));

    const row = await readRaw(postId);
    expect(row.status).toBe("FAILED");
    expect(row.error_code).toBe("platform_processing_timeout");
    expect(publicador.pedidos).toHaveLength(1);
  });
});

describe("slot planificado → post real", () => {
  it("con una conexión activa en la red, el barrido convierte el slot y encola su job", async () => {
    const companyId = await seedCompany(handle);
    const { contentId } = await seedPost(handle, companyId); // deja una conexión tiktok activa
    const at = new Date(NOW.getTime() + 2 * HOUR);
    const [slot] = await withoutCompany(handle.db, (tx) =>
      tx
        .insert(plannedSlots)
        .values({ companyId, contentId, network: "tiktok", scheduledAtUtc: at })
        .returning({ id: plannedSlots.id }),
    );

    await createPublishingSweepHandler({
      db: handle.db,
      queue,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
    })(ctx({ companyId }));

    const [row] = await handle.sql`
      select status, post_id from planned_slots where id = ${slot?.id ?? ""}::uuid`;
    expect(row?.["status"]).toBe("converted");
    const postId = row?.["post_id"] as string;
    const post = await readRaw(postId);
    expect(post.status).toBe("SCHEDULED");
    expect(post.scheduled_at_utc.getTime()).toBe(at.getTime());
    const [job] = queue.en(JOB_QUEUES.publishing);
    expect(job?.payload).toEqual({ companyId, postId });
    expect(job?.options?.singletonKey).toBe(`publishing:${postId}`);
  });

  it.each(["x", "threads", "facebook"] as const)(
    "%s (D-09): con su conexión activa única, el barrido crea el post de esa red",
    async (network) => {
      const companyId = await seedCompany(handle);
      const { contentId } = await seedPost(handle, companyId);
      await handle.sql`
        insert into connections (company_id, platform, platform_user_id, platform_username, scopes, publishable)
        values (${companyId}::uuid, ${network}, ${`${network}-sweep`}, ${network}, '{}', true)`;
      const at = new Date(NOW.getTime() + 2 * HOUR);
      const [slot] = await withoutCompany(handle.db, (tx) =>
        tx
          .insert(plannedSlots)
          .values({ companyId, contentId, network, scheduledAtUtc: at })
          .returning({ id: plannedSlots.id }),
      );

      await createPublishingSweepHandler({
        db: handle.db,
        queue,
        clock,
        appRole: APP_ROLE,
        logger: silencioso,
      })(ctx({ companyId }));

      const [row] = await handle.sql`
        select status, post_id from planned_slots where id = ${slot?.id ?? ""}::uuid`;
      expect(row?.["status"]).toBe("converted");
      const [post] = await handle.sql`
        select platform, status from posts where id = ${row?.["post_id"] as string}::uuid`;
      expect(post).toMatchObject({ platform: network, status: "SCHEDULED" });
      expect(queue.en(JOB_QUEUES.publishing)).toHaveLength(1);
    },
  );

  it("un slot cuya hora ya pasó no se convierte", async () => {
    const companyId = await seedCompany(handle);
    const { contentId } = await seedPost(handle, companyId);
    await withoutCompany(handle.db, (tx) =>
      tx.insert(plannedSlots).values({
        companyId,
        contentId,
        network: "tiktok",
        scheduledAtUtc: new Date(NOW.getTime() - HOUR),
      }),
    );

    await createPublishingSweepHandler({
      db: handle.db,
      queue,
      clock,
      appRole: APP_ROLE,
      logger: silencioso,
    })(ctx({ companyId }));

    expect(queue.en(JOB_QUEUES.publishing)).toHaveLength(0);
  });
});
