/**
 * `Regenerate Text` de punta a punta, del lado del editor — `AI-004`, `F-059`.
 *
 * `POST /content/:id/regenerate` → el job que la ruta encola → **el handler
 * real de `content-rebuild`** del worker, con un LLM fake → `GET
 * /content/:id/editable`. Lo que fija: el editor recibe las cajas nuevas (el
 * copy regenerado, con los mismos ids, geometría y estilo), y la pieza queda
 * `CREATED` con `lastEdit {kind: "regenerate", outcome: "applied"}`.
 *
 * Es una pieza de Blitz: nace **sin** cajas guardadas, así que antes del
 * regenerate `GET /editable` devuelve las derivadas del payload y después las
 * guardadas por el worker. Si el worker renderizara el copy nuevo sin
 * guardarlo, el editor seguiría mostrando el viejo.
 *
 * ## Por qué el worker entra por un `import()` dinámico
 *
 * `apps/api` no depende de `apps/worker` y su `tsconfig` tiene `rootDir: "."`:
 * un `import` estático del worker rompería el typecheck (el archivo queda fuera
 * del `rootDir`) y metería a la API en el grafo del worker. El `import()` con
 * una URL calculada lo resuelve `vitest` en tiempo de ejecución, contra el
 * mismo código que monta el worker, sin tocar el grafo de ninguna de las dos
 * apps. La forma del módulo se declara acá abajo, a mano.
 */
import { randomUUID } from "node:crypto";
import { MemoryMediaRenderer, MemoryStorage } from "@fastgram/adapters";
import { JOB_QUEUES } from "@fastgram/core";
import { APP_ROLE, type Database } from "@fastgram/db";
import type {
  Clock,
  JobContext,
  Llm,
  LlmJsonRequest,
  MediaRenderer,
  Storage,
} from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { dataOf, startApi, type ApiHarness } from "./helpers/harness.js";

/** La parte de `apps/worker/src/content/rebuild-handler.ts` que usa este test. */
interface WorkerRebuildModule {
  createContentRebuildHandler(deps: {
    readonly db: Database;
    readonly renderer: MediaRenderer;
    readonly storage: Storage;
    readonly clock: Clock;
    readonly appRole?: string;
    readonly logger: {
      info(obj: Record<string, unknown>, msg: string): void;
      warn(obj: Record<string, unknown>, msg: string): void;
      error(obj: Record<string, unknown>, msg: string): void;
    };
    readonly copyLlm?: () => Promise<Llm | null>;
    readonly fence?: () => string;
  }): (ctx: JobContext<unknown>) => Promise<void>;
}

const WORKER_REBUILD_HANDLER = new URL(
  "../../worker/src/content/rebuild-handler.ts",
  import.meta.url,
).href;

let api: ApiHarness;
let worker: WorkerRebuildModule;

beforeAll(async () => {
  api = await startApi();
  // El `as` es la frontera del import dinámico: el módulo no tiene tipos del
  // lado de la API (ver la cabecera). La forma la usa el test entero; si
  // cambiara, el test falla al llamar al handler.
  worker = (await import(
    /* @vite-ignore */ WORKER_REBUILD_HANDLER
  )) as WorkerRebuildModule;
}, 180_000);

afterAll(async () => {
  await api?.close();
});

beforeEach(() => {
  api.queue.reset();
});

/** Lo que escribe Blitz (`blitz-build.ts`, `textFor`) en un wall-of-text 1080×1920. */
const WALL = {
  canvas: { width: 1080, height: 1920 },
  video: {
    url: "https://cdn.example.test/bg.mp4",
    drawX: 0,
    drawY: 0,
    drawW: 1080,
    drawH: 1920,
  },
  text: {
    content: "Consistency without burnout",
    x: 540,
    y: 1344,
    width: 972,
    fontSize: 18,
    color: "#FFFFFF",
    textAlign: "center",
    fontWeight: 700,
    strokeWidth: 3,
    strokeColor: "#000000",
  },
};

type Box = {
  id: string;
  text: string;
  position: unknown;
  widthPercent: number;
  font: unknown;
  color: string;
  stroke: unknown;
  background: unknown;
};

const editableBoxes = async (contentId: string): Promise<Box[]> => {
  const res = await api.request({
    method: "GET",
    path: `/api/v1/content/${contentId}/editable`,
  });
  expect(res.status).toBe(200);
  return (dataOf(res) as { textBoxes: Box[] }).textBoxes;
};

/** Un LLM fake que contesta el copy dado y guarda el pedido. */
function llmQueDice(texts: string[], pedidos: LlmJsonRequest[]): Llm {
  return {
    complete: () => Promise.reject(new Error("el regenerate va por completeJson")),
    completeJson: async (req) => {
      pedidos.push(req);
      return {
        value: { texts },
        raw: JSON.stringify({ texts }),
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
        model: "fake-llm",
        deterministic: true,
        latencyMs: 1,
      };
    },
  };
}

describe("después del regenerate, el editor recibe las cajas nuevas", () => {
  it("POST /regenerate → worker con LLM → GET /editable trae el copy nuevo", async () => {
    const companyId = api.data.a.companyId;
    const contentId = randomUUID();
    await api.handle.sql`
      insert into contents (id, company_id, type, status, revision, files, build_payload)
      values (${contentId}::uuid, ${companyId}::uuid, 'wall-of-text', 'CREATED', 1,
              ${["https://cdn.example.test/prev.mp4"]}::text[],
              ${JSON.stringify(WALL)}::jsonb)
    `;
    const [antes] = await editableBoxes(contentId);
    expect(antes?.text).toBe("Consistency without burnout");

    const res = await api.request({
      method: "POST",
      path: `/api/v1/content/${contentId}/regenerate`,
      body: { prompt: "Make it about Monday mornings", mentionBusiness: false },
      idempotencyKey: `regen-${randomUUID()}`,
    });
    expect(res.status).toBe(200);

    const [job] = api.queue.forQueue(JOB_QUEUES.contentRebuild);
    if (job === undefined) throw new Error("la ruta no encoló el rebuild");

    const pedidos: LlmJsonRequest[] = [];
    const handler = worker.createContentRebuildHandler({
      db: api.handle.db,
      renderer: new MemoryMediaRenderer(),
      storage: new MemoryStorage(api.clock, "memory://bucket"),
      clock: api.clock,
      appRole: APP_ROLE,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      copyLlm: async () => llmQueDice(["Mondays don't have to hurt"], pedidos),
    });
    await handler({ jobId: "job_e2e", payload: job.payload, attempt: 1, maxAttempts: 3 });

    // El prompt del usuario llegó al modelo, y como dato.
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]?.messages[0]?.content).not.toContain("Monday mornings");
    expect(pedidos[0]?.untrusted?.[0]?.content).toContain(
      "Make it about Monday mornings",
    );

    const despues = await editableBoxes(contentId);
    expect(despues).toHaveLength(1);
    const [caja] = despues;
    expect(caja?.text).toBe("Mondays don't have to hurt");
    // Sólo cambió el texto: mismo id, geometría y estilo que el editor veía.
    const { text: _viejo, ...restoAntes } = antes as Box;
    const { text: _nuevo, ...restoDespues } = caja as Box;
    expect(restoDespues).toEqual(restoAntes);

    const pieza = await api.request({
      method: "GET",
      path: `/api/v1/content/${contentId}`,
    });
    const content = dataOf(pieza) as {
      status: string;
      revision: number;
      files: string[];
      lastEdit: Record<string, unknown>;
    };
    expect(content.status).toBe("CREATED");
    expect(content.revision).toBe(2);
    expect(content.files).not.toEqual(["https://cdn.example.test/prev.mp4"]);
    expect(content.lastEdit).toMatchObject({ outcome: "applied", kind: "regenerate" });
  });
});
