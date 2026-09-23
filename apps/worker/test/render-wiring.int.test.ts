/**
 * Con qué renderer corre cada cola, **atravesando** `createHandlers` — trampa
 * 46: un test de «qué se monta» no ve «con qué se monta».
 *
 * `main.ts` decide con `selectWorkerRenderers(createRenderServiceRenderers(…))`
 * y le pasa el resultado a `createHandlers`. Este archivo hace exactamente eso
 * con un `fetch` falso que contesta como `services/render`, y después corre los
 * handlers de `content-build` y `content-rebuild` contra Postgres real. Lo que
 * se mide es **quién recibió el `POST /render`**: si alguien vuelve a montar el
 * de memoria para los builds con el servicio configurado, el servicio no ve
 * ningún pedido y la pieza sale igual `CREATED` —que es por qué mirar sólo el
 * estado de la pieza no alcanzaría—.
 */
import { FixedClock, MemoryStorage, type RenderFetch } from "@fastgram/adapters";
import { JOB_QUEUES } from "@fastgram/core";
import { APP_ROLE, migrateWithUrl, type DbHandle } from "@fastgram/db";
import type { JobContext, JobHandler } from "@fastgram/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createHandlers, type WorkerHandlerDeps } from "../src/handlers.js";
import {
  createRenderServiceRenderers,
  selectWorkerRenderers,
  type WorkerRenderers,
} from "../src/media/render-service.js";
import { DATABASE_URL, openDb, seedCompany, seedPiece } from "./helpers/fixtures.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const BASE = "http://render.test:3002";
const SECRETO_DE_PRUEBA = "w".repeat(32);
const clock = new FixedClock(NOW);
const silencioso = { info: () => {}, warn: () => {}, error: () => {} };

let handle: DbHandle;
let companyId: string;

interface Llamada {
  readonly method: string;
  readonly path: string;
}

/**
 * Lo mínimo de `services/render` para que un wall-of-text salga: versión de
 * motor, un `POST /render` con un artefacto y los bytes del artefacto. El
 * `/thumbnail` contesta 404: el handler lo tolera y sigue (se loguea), y así
 * el test no depende de él.
 */
function servicioFalso(): { fetch: RenderFetch; llamadas: Llamada[] } {
  const llamadas: Llamada[] = [];
  const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112, 105, 115, 111, 109]);
  const fetch: RenderFetch = (input, init) => {
    const path = input.slice(BASE.length);
    llamadas.push({ method: init.method, path });
    const json = (value: unknown): Response =>
      new Response(JSON.stringify(value), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (path === "/capabilities") {
      return Promise.resolve(
        json({
          ffmpeg: { available: true, version: "9.0.1" },
          textStrategy: "sharp-overlay",
        }),
      );
    }
    if (path === "/render") {
      return Promise.resolve(
        json({
          type: "wall-of-text",
          artifacts: [
            { kind: "video", index: 0, bytes: bytes.length, href: "/artifact/abc.mp4" },
          ],
          warnings: [],
          cache: { base: "miss", build: "miss" },
          keys: {},
        }),
      );
    }
    if (path === "/artifact/abc.mp4") {
      return Promise.resolve(
        new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "video/mp4",
            "content-length": String(bytes.length),
          },
        }),
      );
    }
    return Promise.resolve(new Response("{}", { status: 404 }));
  };
  return { fetch, llamadas };
}

function deps(renderers: WorkerRenderers): WorkerHandlerDeps {
  return {
    db: handle.db,
    ...renderers,
    storage: new MemoryStorage(clock, "memory://bucket"),
    clock,
    appRole: APP_ROLE,
    logger: silencioso,
    brandAnalysis: { kind: "unmounted", missing: ["test"] },
    copywriter: null,
  };
}

const ctx = (payload: unknown): JobContext<unknown> => ({
  jobId: "job_wiring",
  payload,
  attempt: 1,
  maxAttempts: 3,
});

async function estado(contentId: string): Promise<string> {
  const filas =
    await handle.sql`select status from contents where id = ${contentId}::uuid`;
  return (filas[0] as unknown as { status: string }).status;
}

async function correr(
  handlers: Readonly<Record<string, JobHandler<unknown>>>,
  cola: string,
  contentId: string,
  revision: number,
  reason: string,
): Promise<void> {
  const handler = handlers[cola];
  if (handler === undefined) throw new Error(`${cola} no está montada`);
  await handler(
    ctx({ companyId, contentId, contentType: "wall-of-text", revision, reason }),
  );
}

beforeAll(async () => {
  await migrateWithUrl(DATABASE_URL);
  handle = openDb();
  companyId = await seedCompany(handle);
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

describe("el cableado de los renderers a través de createHandlers", () => {
  it("sin servicio de render: los builds salen con el de memoria y la normalización no se monta", async () => {
    const { handlers } = createHandlers(deps(selectWorkerRenderers(null)));
    expect(handlers[JOB_QUEUES.mediaNormalization]).toBeUndefined();

    const contentId = await seedPiece(handle, companyId);
    await correr(handlers, JOB_QUEUES.contentBuild, contentId, 1, "create");
    expect(await estado(contentId)).toBe("CREATED");
  });

  it("con servicio de render: content-build y content-rebuild le piden el render a él", async () => {
    const { fetch, llamadas } = servicioFalso();
    const created = await createRenderServiceRenderers(
      { baseUrl: BASE, grantSecret: SECRETO_DE_PRUEBA },
      { fetch, clock },
    );
    // Una sola consulta de versión para las dos instancias.
    expect(llamadas.filter((l) => l.path === "/capabilities")).toHaveLength(1);
    expect(created.build).not.toBe(created.normalization);

    const { handlers } = createHandlers(deps(selectWorkerRenderers(created)));
    expect(handlers[JOB_QUEUES.mediaNormalization]).toBeDefined();

    const build = await seedPiece(handle, companyId);
    await correr(handlers, JOB_QUEUES.contentBuild, build, 1, "create");
    expect(await estado(build)).toBe("CREATED");
    const trasBuild = llamadas.filter((l) => l.method === "POST" && l.path === "/render");
    expect(trasBuild).toHaveLength(1);

    // El rebuild: misma pieza con otra revisión, como la deja la API tras una
    // edición sin cajas de texto.
    const rebuild = await seedPiece(handle, companyId, { revision: 2 });
    await correr(handlers, JOB_QUEUES.contentRebuild, rebuild, 2, "edit");
    expect(await estado(rebuild)).toBe("CREATED");
    expect(
      llamadas.filter((l) => l.method === "POST" && l.path === "/render"),
    ).toHaveLength(2);
    expect(llamadas.filter((l) => l.path === "/artifact/abc.mp4")).toHaveLength(2);
  });
});
