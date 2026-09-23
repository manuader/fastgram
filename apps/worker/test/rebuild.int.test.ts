/**
 * El handler de `content-rebuild`, contra Postgres — PRD §9.5.4, `FR-051`.
 *
 * ## Qué persigue este archivo
 *
 * Que una edición que falla **no cueste plata ni la pieza**. El motor es el de
 * `content-build` (ese archivo ya prueba render, subida y carreras); lo que acá
 * importa es lo que cambia:
 *
 *  - un fallo definitivo vuelve a `CREATED` con los `files` **anteriores** y
 *    `lastEdit` fallido (PRD:1204), nunca `FAILED`;
 *  - **nunca reembolsa**: la fila trae el `saveBucket` del build original, que
 *    se entregó, y devolverlo sería un save gratis por edición fallida;
 *  - una pieza con cajas de texto no se renderiza —el render no las lee— y se
 *    cierra con `edit_not_renderable` en vez de declararse aplicada;
 *  - un job de edición que quedó en la cola `content-build` se cierra igual;
 *  - y `createHandlers` lo monta con el renderer de `content-build`.
 *
 * Corre con `SET LOCAL ROLE fastgram_app` (trampa 16).
 */
import { FixedClock, MemoryMediaRenderer, MemoryStorage } from "@fastgram/adapters";
import { JOB_QUEUES } from "@fastgram/core";
import { APP_ROLE, migrateWithUrl, type DbHandle } from "@fastgram/db";
import {
  PortError,
  type JobContext,
  type MediaRenderer,
  type RenderJob,
} from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createContentBuildHandler,
  type BuildLogger,
} from "../src/content/build-handler.js";
import { createContentRebuildHandler } from "../src/content/rebuild-handler.js";
import {
  DATABASE_URL,
  PERIOD,
  openDb,
  seedCompany,
  seedPiece,
} from "./helpers/fixtures.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");
const PREVIOS = ["memory://bucket/content/previo/1/0"];
const PREVIA_THUMB = "memory://bucket/content/previo/1/thumb";

let handle: DbHandle;
let companyId: string;

const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

/** Un renderer de memoria que cuenta, puede fallar y puede mutar la base a mitad. */
class RendererEspia implements MediaRenderer {
  readonly #inner = new MemoryMediaRenderer();
  next: Error | null = null;
  duranteElRender: (() => Promise<void>) | null = null;
  calls = 0;

  async renderAll(...args: Parameters<MediaRenderer["renderAll"]>) {
    this.calls += 1;
    if (this.duranteElRender !== null) {
      const fn = this.duranteElRender;
      this.duranteElRender = null;
      await fn();
    }
    if (this.next !== null) {
      const error = this.next;
      this.next = null;
      throw error;
    }
    return this.#inner.renderAll(...args);
  }
  async render(...args: Parameters<MediaRenderer["render"]>) {
    return this.#inner.render(...args);
  }
  fingerprint(job: RenderJob) {
    return this.#inner.fingerprint(job);
  }
  async normalize(...args: Parameters<MediaRenderer["normalize"]>) {
    return this.#inner.normalize(...args);
  }
  async probe(...args: Parameters<MediaRenderer["probe"]>) {
    return this.#inner.probe(...args);
  }
  async thumbnail(...args: Parameters<MediaRenderer["thumbnail"]>) {
    return this.#inner.thumbnail(...args);
  }
}

let renderer: RendererEspia;
let storage: MemoryStorage;
const clock = new FixedClock(NOW);

const deps = () => ({
  db: handle.db,
  renderer,
  storage,
  clock,
  appRole: APP_ROLE,
  logger: silencioso,
});

const rebuild = () => createContentRebuildHandler(deps());

const ctx = (payload: unknown, attempt = 1, maxAttempts = 3): JobContext<unknown> => ({
  jobId: "job_rebuild",
  payload,
  attempt,
  maxAttempts,
});

const jobFor = (
  contentId: string,
  revision = 2,
  reason: string = "edit",
  company = companyId,
) => ({
  companyId: company,
  contentId,
  contentType: "wall-of-text",
  revision,
  reason,
});

/**
 * Una pieza como la deja la API tras aceptar una edición: `BUILDING`,
 * `revision` 2, los `files` de la revisión 1 intactos, `lastEdit` aplicado, y
 * **el cargo del build original** en la fila.
 */
async function enRebuild(
  options: { cajas?: boolean; company?: string; buildPayload?: unknown } = {},
): Promise<string> {
  const company = options.company ?? companyId;
  const contentId = await seedPiece(handle, company, {
    revision: 2,
    ...(options.buildPayload === undefined ? {} : { buildPayload: options.buildPayload }),
  });
  await handle.sql`
    update contents
    set files = ${PREVIOS}::text[],
        thumbnail_url = ${PREVIA_THUMB},
        last_edit = ${JSON.stringify({ at: 1, outcome: "applied", kind: "minor" })}::jsonb
    where id = ${contentId}::uuid
  `;
  if (options.cajas === true) {
    await handle.sql`
      insert into content_text_boxes
        (id, content_id, company_id, slide_index, text, position, width_percent,
         font, color, stroke, background)
      values ('slide-0-text-0', ${contentId}::uuid, ${company}::uuid, 0, 'Editado',
              ${JSON.stringify({ x: 10, y: 20 })}::jsonb, 80,
              ${JSON.stringify({ family: "anton", weight: 400, size: 48 })}::jsonb,
              '#FFFFFF', ${JSON.stringify({ width: 2, color: "#000000" })}::jsonb, null)
    `;
  }
  return contentId;
}

async function pieza(contentId: string) {
  const filas = await handle.sql`
    select status, files, thumbnail_url, revision, save_bucket, save_refunded_at, last_edit
    from contents where id = ${contentId}::uuid
  `;
  return filas[0] as unknown as {
    status: string;
    files: string[];
    thumbnail_url: string | null;
    revision: number;
    save_bucket: string | null;
    save_refunded_at: unknown;
    last_edit: Record<string, unknown> | null;
  };
}

async function usados(company = companyId): Promise<number> {
  const filas = await handle.sql`
    select content_saves_used from quota_ledgers
    where company_id = ${company}::uuid and period = ${PERIOD}
  `;
  return (filas[0] as unknown as { content_saves_used: number }).content_saves_used;
}

beforeAll(async () => {
  await migrateWithUrl(DATABASE_URL);
  handle = openDb();
  companyId = await seedCompany(handle);
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

beforeEach(() => {
  renderer = new RendererEspia();
  storage = new MemoryStorage(clock, "memory://bucket");
});

describe("una edición de cajas de texto no se puede renderizar hoy", () => {
  it("vuelve a CREATED con los files anteriores, sin llamar al renderer", async () => {
    const contentId = await enRebuild({ cajas: true });

    await rebuild()(ctx(jobFor(contentId)));

    const row = await pieza(contentId);
    // Primero lo que no tiene que pasar (trampa 35).
    expect(row.status).not.toBe("FAILED");
    expect(renderer.calls).toBe(0);
    expect(row.status).toBe("CREATED");
    expect(row.files).toEqual(PREVIOS);
    expect(row.thumbnail_url).toBe(PREVIA_THUMB);
    expect(row.revision).toBe(2);
    expect(row.last_edit).toEqual({
      at: NOW.getTime(),
      outcome: "failed",
      kind: "minor",
      failureReason: "edit_not_renderable",
    });
  });

  it("regenerate queda con kind `regenerate`", async () => {
    const contentId = await enRebuild({ cajas: true });

    await rebuild()(ctx(jobFor(contentId, 2, "regenerate")));

    expect((await pieza(contentId)).last_edit).toMatchObject({
      outcome: "failed",
      kind: "regenerate",
    });
  });

  it("no reembolsa el save del build original", async () => {
    const contentId = await enRebuild({ cajas: true });
    const antes = await usados();

    await rebuild()(ctx(jobFor(contentId)));

    const row = await pieza(contentId);
    expect(row.save_refunded_at).toBeNull();
    expect(await usados()).toBe(antes);
    expect(row.save_bucket).toBe("included");
  });
});

describe("el camino que renderiza: pieza sin cajas", () => {
  it("renderiza, sube con la revisión nueva y deja CREATED", async () => {
    const contentId = await enRebuild();
    const antes = await usados();

    await rebuild()(ctx(jobFor(contentId)));

    const row = await pieza(contentId);
    expect(renderer.calls).toBe(1);
    expect(row.status).toBe("CREATED");
    expect(row.files).toHaveLength(1);
    expect(row.files).not.toEqual(PREVIOS);
    expect(decodeURIComponent(row.files[0] ?? "")).toContain(`/${contentId}/2/`);
    expect(await usados()).toBe(antes);
  });

  it("un fallo permanente del render vuelve a CREATED y NO reembolsa", async () => {
    // Éste es el caso que el handler de build cerraba con FAILED **y
    // reembolso**: la pieza tiene cargo del build original, así que devolverlo
    // regalaba un save.
    const contentId = await enRebuild();
    const antes = await usados();
    renderer.next = new PortError("bad_request", "detalle interno del motor", {
      source: "MediaRenderer/test",
    });

    await rebuild()(ctx(jobFor(contentId)));

    const row = await pieza(contentId);
    expect(row.save_refunded_at).toBeNull();
    expect(await usados()).toBe(antes);
    expect(row.status).toBe("CREATED");
    expect(row.files).toEqual(PREVIOS);
    // Código estable, sin el mensaje del proveedor: `lastEdit` sale por la API.
    expect(row.last_edit?.["failureReason"]).toBe("bad_request");
    expect(JSON.stringify(row.last_edit)).not.toContain("detalle interno");
  });

  it("un payload roto es permanente: no reintenta y vuelve a CREATED", async () => {
    const contentId = await enRebuild({ buildPayload: { roto: true } });

    await rebuild()(ctx(jobFor(contentId), 1, 3));

    const row = await pieza(contentId);
    expect(renderer.calls).toBe(0);
    expect(row.status).toBe("CREATED");
    expect(row.last_edit?.["failureReason"]).toBe("invalid_build_payload");
  });
});

describe("reintentos", () => {
  it("un fallo transitorio relanza y deja BUILDING con la versión anterior", async () => {
    const contentId = await enRebuild();
    renderer.next = new PortError("provider_unavailable", "no responde", { source: "t" });

    await expect(rebuild()(ctx(jobFor(contentId), 1, 3))).rejects.toThrow();

    const row = await pieza(contentId);
    expect(row.status).toBe("BUILDING");
    expect(row.files).toEqual(PREVIOS);
  });

  it("en el último intento no relanza: CREATED, sin reembolso", async () => {
    const contentId = await enRebuild();
    const antes = await usados();
    renderer.next = new PortError("provider_unavailable", "sigue sin responder", {
      source: "t",
    });

    await rebuild()(ctx(jobFor(contentId), 3, 3));

    const row = await pieza(contentId);
    expect(await usados()).toBe(antes);
    expect(row.status).toBe("CREATED");
    expect(row.last_edit?.["failureReason"]).toBe("provider_unavailable");
  });
});

describe("reentrega idempotente", () => {
  it("tras un fallo, la segunda entrega no reescribe nada", async () => {
    const contentId = await enRebuild({ cajas: true });
    await rebuild()(ctx(jobFor(contentId)));
    const primera = await pieza(contentId);

    // Otro reloj: si la segunda entrega reescribiera `lastEdit`, cambiaría `at`.
    const tarde = createContentRebuildHandler({
      ...deps(),
      clock: new FixedClock(new Date("2026-09-22T00:00:00.000Z")),
    });
    await tarde(ctx(jobFor(contentId)));

    expect(await pieza(contentId)).toEqual(primera);
  });

  it("tras un éxito, la segunda entrega no vuelve a renderizar", async () => {
    const contentId = await enRebuild();
    await rebuild()(ctx(jobFor(contentId)));
    const primera = await pieza(contentId);

    await rebuild()(ctx(jobFor(contentId)));

    expect(renderer.calls).toBe(1);
    expect(await pieza(contentId)).toEqual(primera);
  });

  it("un job de una revisión vieja no toca la pieza", async () => {
    const contentId = await enRebuild({ cajas: true });

    await rebuild()(ctx(jobFor(contentId, 1)));

    const row = await pieza(contentId);
    expect(row.status).toBe("BUILDING");
    expect(row.last_edit).toMatchObject({ outcome: "applied" });
  });

  it("una edición que entra durante el render: se descarta y no se cierra", async () => {
    const contentId = await enRebuild();
    renderer.duranteElRender = async () => {
      await handle.sql`update contents set revision = 3 where id = ${contentId}::uuid`;
    };
    renderer.next = new PortError("bad_request", "no", { source: "t" });

    await rebuild()(ctx(jobFor(contentId)));

    const row = await pieza(contentId);
    expect(row.status).toBe("BUILDING");
    expect(row.last_edit).toMatchObject({ outcome: "applied" });
  });

  it("si otra entrega cerró la pieza durante el render, el fallo no pisa su resultado", async () => {
    // La guarda de `status` al **escribir** el cierre, no la de la lectura: la
    // reentrega secuencial la frena el chequeo de lectura (trampa 24) y este
    // caso no. Es pg-boss reentregando un job que venció su timeout mientras el
    // primero seguía vivo: el primero termina bien y el segundo falla después.
    // Sin la guarda, `lastEdit` diría `failed` sobre una pieza reconstruida.
    const contentId = await enRebuild();
    renderer.duranteElRender = async () => {
      await handle.sql`
        update contents set status = 'CREATED', files = ${["memory://bucket/nuevo/2/0"]}::text[]
        where id = ${contentId}::uuid
      `;
    };
    renderer.next = new PortError("bad_request", "no", { source: "t" });

    await rebuild()(ctx(jobFor(contentId)));

    const row = await pieza(contentId);
    expect(row.last_edit).toMatchObject({ outcome: "applied" });
    expect(row.files).toEqual(["memory://bucket/nuevo/2/0"]);
  });
});

describe("aislamiento", () => {
  it("un job con el companyId de otro workspace no toca la pieza", async () => {
    const otro = await seedCompany(handle);
    const ajena = await enRebuild({ cajas: true, company: otro });
    const antesOtro = await usados(otro);

    await rebuild()(ctx(jobFor(ajena, 2, "edit", companyId)));

    const row = await pieza(ajena);
    expect(row.status).toBe("BUILDING");
    expect(row.last_edit).toMatchObject({ outcome: "applied" });
    expect(await usados(otro)).toBe(antesOtro);
    expect(renderer.calls).toBe(0);
  });
});

describe("jobs de edición que quedaron en la cola content-build", () => {
  it("el handler de build los cierra como rebuild: CREATED y sin reembolso", async () => {
    // Antes de `content-rebuild`, la API encolaba las ediciones en
    // `content-build`. Uno que quede en la cola al desplegar cae en ese
    // handler, que cerraba con FAILED y devolvía el save del build original.
    const contentId = await enRebuild();
    const antes = await usados();
    renderer.next = new PortError("bad_request", "no", { source: "t" });

    await createContentBuildHandler(deps())(ctx(jobFor(contentId, 2, "edit")));

    const row = await pieza(contentId);
    expect(row.save_refunded_at).toBeNull();
    expect(await usados()).toBe(antes);
    expect(row.status).toBe("CREATED");
    expect(row.files).toEqual(PREVIOS);
  });
});

describe("el cableado de createHandlers — trampa 46", () => {
  it("content-rebuild usa el renderer de content-build, nunca el de normalización", async () => {
    const { createHandlers } = await import("../src/handlers.js");
    const trampa = new RendererEspia();
    trampa.next = new Error("usó el renderer de normalización");
    const contentId = await enRebuild();

    const { handlers } = createHandlers({
      ...deps(),
      normalizationRenderer: trampa,
      brandAnalysis: { kind: "unmounted", missing: [] },
      copywriter: null,
    });
    const rehacer = handlers[JOB_QUEUES.contentRebuild];
    if (rehacer === undefined) throw new Error("content-rebuild no se montó");

    await rehacer(ctx(jobFor(contentId)));

    expect(trampa.calls).toBe(0);
    expect(renderer.calls).toBe(1);
    expect((await pieza(contentId)).status).toBe("CREATED");
  });

  it("y cierra como rebuild, no como build: un fallo no reembolsa", async () => {
    // Montar `createContentBuildHandler` en la clave de `content-rebuild` es el
    // otro error de una línea posible. Con un job sin `reason` de edición, sólo
    // la cola decide el modo.
    const { createHandlers } = await import("../src/handlers.js");
    const contentId = await enRebuild();
    const antes = await usados();
    renderer.next = new PortError("bad_request", "no", { source: "t" });

    const { handlers } = createHandlers({
      ...deps(),
      normalizationRenderer: null,
      brandAnalysis: { kind: "unmounted", missing: [] },
      copywriter: null,
    });
    const rehacer = handlers[JOB_QUEUES.contentRebuild];
    if (rehacer === undefined) throw new Error("content-rebuild no se montó");
    await rehacer(ctx(jobFor(contentId, 2, "create")));

    expect(await usados()).toBe(antes);
    expect((await pieza(contentId)).status).toBe("CREATED");
  });
});
