/**
 * `brand-backgrounds` contra Postgres real — `PU-MEDIA-002`.
 *
 * El generador es el **`HttpMediaRenderer` real** con un `fetch` que contesta
 * como `services/render` (`POST /brand-backgrounds` + `GET /artifact/…`): lo
 * que se atraviesa es el adaptador, el grant, la subida al storage y las filas.
 * Que el servicio devuelva de verdad un JPEG 1080×1350 o un MP4 H.264 lo mide
 * `services/render/src/render/brandBackground.integration.test.ts`.
 *
 * Lo que se mide acá:
 *  · el kit crea 8 + 3 filas `ready`, `origin = brand_kit`, con sus categorías,
 *    bajo `media/<marca>/` (el prefijo que autoriza el build);
 *  · esas filas son **elegibles** por Blitz (`listPlanningMedia`) y con ellas
 *    `formatsWithMedia` pasa de nada a slideshow + wall-of-text;
 *  · idempotencia: una segunda entrega no llama al render ni duplica;
 *  · un fallo a mitad guarda lo hecho y la reentrega sólo genera lo que falta;
 *  · la paleta sale del perfil si trae colores, si no la curada por id;
 *  · el refill sin media encola el kit **una** vez.
 */
import { randomUUID } from "node:crypto";

import {
  FixedClock,
  HttpMediaRenderer,
  MemoryStorage,
  SeededRng,
} from "@fastgram/adapters";
import type { RenderFetch } from "@fastgram/adapters";
import {
  AUTO_BRAND_KIT_SEED,
  JOB_QUEUES,
  buildMediaBank,
  defaultPaletteFor,
  formatsWithMedia,
} from "@fastgram/core";
import {
  APP_ROLE,
  companyProfiles,
  discoveryQueueStore,
  withCompany,
  withoutCompany,
  type DbHandle,
} from "@fastgram/db";
import type { EnqueuedJob, JobContext, JobSpec, Queue } from "@fastgram/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { BuildLogger } from "../src/content/build-handler.js";
import { createBrandBackgroundsHandler } from "../src/brand-kit/handler.js";
import { createAutoBrandKitTrigger } from "../src/brand-kit/mount.js";
import type { SuggestionCopywriter } from "../src/discovery/copywriter.js";
import { createDiscoveryRefillHandler } from "../src/discovery/refill-handler.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const BASE = "http://render.test:3002";
const SECRET = "b".repeat(40);
const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

let handle: DbHandle;

beforeAll(() => {
  handle = openDb();
});

afterAll(async () => {
  await handle?.close();
});

interface Pedido {
  readonly kind: string;
  readonly seed: string;
  readonly palette: readonly string[];
  readonly aspectRatio: string;
  readonly grant: unknown;
}

/**
 * `services/render` falso. `falla(n)` hace que el pedido número `n` (desde 1)
 * conteste 500 `render_failed`, que el adaptador traduce a reintentable.
 */
function servicio(opciones: { readonly falla?: number } = {}) {
  const pedidos: Pedido[] = [];
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70]);
  const mp4 = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
  const fetch: RenderFetch = (input, init) => {
    const path = input.slice(BASE.length);
    if (path === "/brand-backgrounds") {
      const body = JSON.parse(init.body ?? "{}") as Pedido;
      pedidos.push(body);
      if (opciones.falla === pedidos.length) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              error: { code: "render_failed", message: "x", details: {} },
            }),
            { status: 500, headers: { "content-type": "application/json" } },
          ),
        );
      }
      const video = body.kind === "video";
      return Promise.resolve(
        new Response(
          JSON.stringify({
            contentType: video ? "video/mp4" : "image/jpeg",
            sizeBytes: (video ? mp4 : jpeg).length,
            width: 1080,
            height: video || body.aspectRatio === "9:16" ? 1920 : 1350,
            ...(video ? { durationSeconds: 8.0 } : {}),
            href: video ? "/artifact/v.mp4" : "/artifact/i.jpg",
            cache: "miss",
            warnings: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    }
    if (path === "/artifact/v.mp4" || path === "/artifact/i.jpg") {
      const bytes = path.endsWith(".mp4") ? mp4 : jpeg;
      return Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: {
            "content-type": path.endsWith(".mp4") ? "video/mp4" : "image/jpeg",
            "content-length": String(bytes.length),
          },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  };
  const generator = new HttpMediaRenderer({
    baseUrl: BASE,
    engineVersion: "test",
    grantSecret: SECRET,
    fetch,
  });
  return { pedidos, generator };
}

function handler(generator: HttpMediaRenderer, storage: MemoryStorage) {
  return createBrandBackgroundsHandler({
    db: handle.db,
    generator,
    storage,
    appRole: APP_ROLE,
    logger: silencioso,
  });
}

const ctx = (payload: unknown, attempt = 1): JobContext<unknown> => ({
  jobId: `job_${randomUUID().slice(0, 8)}`,
  payload,
  attempt,
  maxAttempts: 3,
});

interface Fila {
  media_type: string;
  status: string;
  origin: string;
  categories: string[];
  storage_key: string;
  r2_url: string;
  video_duration_sec: number | null;
  deleted_at: Date | null;
}

async function filas(companyId: string): Promise<Fila[]> {
  return (await handle.sql`
    select media_type::text, status::text, origin::text, categories, storage_key,
           r2_url, video_duration_sec, deleted_at
      from media where company_id = ${companyId}::uuid order by storage_key
  `) as unknown as Fila[];
}

describe("brand-backgrounds — PU-MEDIA-002", () => {
  it("crea 8 imágenes + 3 videos ready, brand_kit, categorizados y elegibles por Blitz", async () => {
    const companyId = await seedCompany(handle);
    const storage = new MemoryStorage(new FixedClock());
    const svc = servicio();

    // Negativa primero: sin media, Blitz no tiene ningún formato.
    const antes = await withCompany(handle.db, companyId, (tx) =>
      discoveryQueueStore.listPlanningMedia(tx, { companyId }),
    );
    expect(formatsWithMedia(buildMediaBank(antes.media, antes.influencerSets))).toEqual(
      [],
    );

    await handler(
      svc.generator,
      storage,
    )(ctx({ companyId, seed: "kit-1", images: 8, videos: 3 }));

    const rows = await filas(companyId);
    expect(rows).toHaveLength(11);
    for (const row of rows) {
      expect(row.status).toBe("ready");
      expect(row.origin).toBe("brand_kit");
      expect(row.storage_key.startsWith(`media/${companyId}/brand-kit/`)).toBe(true);
      // El objeto existe en el storage, con la clave de la fila.
      expect(await storage.head(row.storage_key)).not.toBeNull();
      // La URL canónica de la clave (MemoryStorage la codifica entera).
      expect(decodeURIComponent(row.r2_url)).toContain(row.storage_key);
    }
    const imagenes = rows.filter((r) => r.media_type === "image");
    const videos = rows.filter((r) => r.media_type === "video");
    expect(imagenes).toHaveLength(8);
    expect(videos).toHaveLength(3);
    for (const r of imagenes) {
      expect(r.categories).toEqual(["slideshow-image", "green-screen-background"]);
    }
    for (const r of videos) {
      expect(r.categories).toEqual(["background-video"]);
      expect(r.video_duration_sec).toBe(8);
    }

    // Lo que pidió al render: paleta curada (sin perfil), 4:5 y 9:16, grant.
    expect(svc.pedidos).toHaveLength(11);
    for (const p of svc.pedidos) {
      expect(p.palette).toEqual(defaultPaletteFor(companyId));
      expect(p.grant).toBeDefined();
    }
    expect(
      new Set(svc.pedidos.filter((p) => p.kind === "image").map((p) => p.aspectRatio)),
    ).toEqual(new Set(["4:5", "9:16"]));

    // Elegibles: con el rol de la app (RLS) y el mismo query que usa el refill.
    const despues = await withCompany(
      handle.db,
      companyId,
      (tx) => discoveryQueueStore.listPlanningMedia(tx, { companyId }),
      { role: APP_ROLE },
    );
    expect(
      formatsWithMedia(buildMediaBank(despues.media, despues.influencerSets)),
    ).toEqual(["slideshow", "wall-of-text"]);
  });

  it("idempotente: la segunda entrega no llama al render ni duplica", async () => {
    const companyId = await seedCompany(handle);
    const storage = new MemoryStorage(new FixedClock());
    const payload = { companyId, seed: "kit-idem", images: 2, videos: 1 };

    const primero = servicio();
    await handler(primero.generator, storage)(ctx(payload));
    expect(primero.pedidos).toHaveLength(3);

    const segundo = servicio();
    await handler(segundo.generator, storage)(ctx(payload));
    // Negativa primero (trampa 35).
    expect(segundo.pedidos).toHaveLength(0);
    expect(await filas(companyId)).toHaveLength(3);
  });

  it("un fallo a mitad guarda lo hecho, relanza, y la reentrega sólo hace lo que falta", async () => {
    const companyId = await seedCompany(handle);
    const storage = new MemoryStorage(new FixedClock());
    const payload = { companyId, seed: "kit-falla", images: 3, videos: 1 };

    const roto = servicio({ falla: 3 });
    await expect(handler(roto.generator, storage)(ctx(payload, 1))).rejects.toMatchObject(
      {
        code: "provider_unavailable",
      },
    );
    expect(await filas(companyId)).toHaveLength(2);

    const sano = servicio();
    await handler(sano.generator, storage)(ctx(payload, 2));
    expect(sano.pedidos).toHaveLength(2);
    expect(await filas(companyId)).toHaveLength(4);
  });

  it("un fallo en el último intento no relanza (y lo hecho queda)", async () => {
    const companyId = await seedCompany(handle);
    const storage = new MemoryStorage(new FixedClock());
    const roto = servicio({ falla: 2 });
    await handler(
      roto.generator,
      storage,
    )(ctx({ companyId, seed: "kit-ultimo", images: 2, videos: 0 }, 3));
    expect(await filas(companyId)).toHaveLength(1);
  });

  it("un fondo borrado por el usuario no se regenera en una reentrega", async () => {
    const companyId = await seedCompany(handle);
    const storage = new MemoryStorage(new FixedClock());
    const payload = { companyId, seed: "kit-borrado", images: 2, videos: 0 };
    await handler(servicio().generator, storage)(ctx(payload));
    await handle.sql`
      update media set deleted_at = now()
       where company_id = ${companyId}::uuid and storage_key like '%image-1.jpg'
    `;
    const otra = servicio();
    await handler(otra.generator, storage)(ctx(payload));
    expect(otra.pedidos).toHaveLength(0);
    expect((await filas(companyId)).filter((r) => r.deleted_at === null)).toHaveLength(1);
  });

  it("la paleta sale del perfil cuando trae al menos dos colores", async () => {
    const companyId = await seedCompany(handle);
    await withoutCompany(handle.db, (tx) =>
      tx.insert(companyProfiles).values({
        companyId,
        coreIdentity: "Marca de café. Colores: #3B2F2F y #C8A165, acento #fff.",
      }),
    );
    const svc = servicio();
    await handler(
      svc.generator,
      new MemoryStorage(new FixedClock()),
    )(ctx({ companyId, seed: "kit-perfil", images: 1, videos: 0 }));
    expect(svc.pedidos[0]?.palette).toEqual(["#3B2F2F", "#C8A165", "#FFFFFF"]);
  });

  it("payload inválido: no genera, no lanza", async () => {
    const svc = servicio();
    await handler(
      svc.generator,
      new MemoryStorage(new FixedClock()),
    )(ctx({ companyId: "no-uuid", seed: "x", images: 1, videos: 0 }));
    expect(svc.pedidos).toHaveLength(0);
  });
});

describe("discovery-refill sin media encola el kit — una vez", () => {
  /** Lo mínimo del puerto: honra `singletonKey` como el adaptador real. */
  function colaGrabadora() {
    const jobs: JobSpec<unknown>[] = [];
    const queue: Pick<Queue, "enqueue"> = {
      enqueue<T>(job: JobSpec<T>): Promise<EnqueuedJob> {
        const clave = job.options?.singletonKey;
        const previo = jobs.findIndex((j) => j.options?.singletonKey === clave);
        if (clave !== undefined && previo !== -1) {
          return Promise.resolve({ jobId: `job_${String(previo)}`, created: false });
        }
        jobs.push(job as JobSpec<unknown>);
        return Promise.resolve({ jobId: `job_${String(jobs.length)}`, created: true });
      },
    };
    return { jobs, queue };
  }

  /** Nunca se llama: la selección falla antes de pedir copy. */
  const copywriter: SuggestionCopywriter = {
    write: () => Promise.reject(new Error("no debería pedirse copy sin media")),
  };

  it("el primer refill encola brand-backgrounds con la semilla automática; el segundo no duplica", async () => {
    const companyId = await seedCompany(handle);
    const { jobs, queue } = colaGrabadora();
    const created: boolean[] = [];
    const trigger = createAutoBrandKitTrigger(
      {
        enqueue: async (job) => {
          const r = await queue.enqueue(job);
          created.push(r.created);
          return r;
        },
      },
      silencioso,
    );
    const refill = createDiscoveryRefillHandler({
      db: handle.db,
      rng: new SeededRng(7),
      copywriter,
      appRole: APP_ROLE,
      logger: silencioso,
      onMediaBankEmpty: trigger,
    });

    await refill(ctx({ companyId }));
    await refill(ctx({ companyId }));

    expect(jobs).toHaveLength(1);
    expect(created).toEqual([true, false]);
    expect(jobs[0]?.queue).toBe(JOB_QUEUES.brandBackgrounds);
    expect(jobs[0]?.payload).toEqual({
      companyId,
      seed: AUTO_BRAND_KIT_SEED,
      images: 8,
      videos: 3,
    });
  });

  it("con media suficiente, el refill no dispara el kit", async () => {
    const companyId = await seedCompany(handle);
    const storage = new MemoryStorage(new FixedClock());
    await handler(
      servicio().generator,
      storage,
    )(ctx({ companyId, seed: "kit-previo", images: 2, videos: 1 }));
    const { jobs, queue } = colaGrabadora();
    let pedidasDeCopy = 0;
    const refill = createDiscoveryRefillHandler({
      db: handle.db,
      rng: new SeededRng(7),
      copywriter: {
        write: () => {
          pedidasDeCopy += 1;
          return Promise.resolve({
            ok: false as const,
            reason: "sin copy en este test",
            model: "test",
          });
        },
      },
      appRole: APP_ROLE,
      logger: silencioso,
      onMediaBankEmpty: createAutoBrandKitTrigger(queue, silencioso),
    });
    await refill(ctx({ companyId }));
    expect(jobs).toHaveLength(0);
    // Y llegó a pedir copy: con el kit, la selección ya no falla.
    expect(pedidasDeCopy).toBeGreaterThan(0);
  });
});
