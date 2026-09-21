/**
 * El handler de `content-build`, contra Postgres — `FR-050`, IMPL §2.3.
 *
 * ## Qué persigue este archivo
 *
 * Que el círculo cierre. Hasta ahora `POST /content` creaba la pieza, **cobraba
 * el content save** y encolaba, y del otro lado no había nadie: la pieza se
 * quedaba en `BUILDING` para siempre con el save cobrado y sin devolver.
 *
 * Los casos que importan no son "construye bien". Son los otros cuatro:
 *
 *  - que un fallo **devuelva el save**, al bucket correcto y al período
 *    correcto;
 *  - que devolverlo **dos veces** sea imposible, porque el handler puede
 *    reintentarse (lo dice el puerto `Queue`);
 *  - que un job viejo **no pise** una edición posterior;
 *  - que un reintento sobre una pieza ya cerrada no haga nada.
 *
 * Corre con `SET LOCAL ROLE fastgram_app`: sin el rol, la conexión de
 * desarrollo es superusuario, saltea RLS, y el archivo mediría la mitad de lo
 * que dice medir.
 */
import { FixedClock, MemoryMediaRenderer, MemoryStorage } from "@fastgram/adapters";
import { APP_ROLE, migrateWithUrl, type DbHandle } from "@fastgram/db";
import { PortError, type JobContext, type MediaRenderer, type RenderJob } from "@fastgram/ports";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createContentBuildHandler, type BuildLogger } from "../src/content/build-handler.js";
import {
  DATABASE_URL,
  PERIOD,
  openDb,
  seedCompany,
  seedPiece,
} from "./helpers/fixtures.js";

const NOW = new Date("2026-09-21T12:00:00.000Z");

let handle: DbHandle;
let companyId: string;

/** Un logger que no imprime: lo que se afirma es el estado de la base, no el log. */
const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * Un renderer que puede fallar a pedido.
 *
 * Envuelve al de memoria en vez de reemplazarlo porque el camino feliz tiene que
 * seguir produciendo un artefacto de verdad —bytes, `contentType`, fingerprint—
 * para que la subida y la URL que termina en `files` sean las reales.
 */
class RendererConFallo implements MediaRenderer {
  readonly #inner = new MemoryMediaRenderer();
  /** Se le asigna un error para que el próximo `render` lo lance. */
  next: Error | null = null;
  /**
   * Se corre **durante** el render.
   *
   * Es la única forma de probar la carrera que de verdad importa: la edición
   * del usuario que entra entre que el handler lee la pieza y que escribe el
   * resultado. Esa ventana existe porque el render dura 30 s – 2 min y no puede
   * ocurrir dentro de una transacción; simularla desde afuera con `Promise.all`
   * no la reproduce, porque las dos transacciones del handler son cortas y se
   * ordenarían solas.
   */
  duranteElRender: (() => Promise<void>) | null = null;
  calls = 0;

  async render(job: RenderJob) {
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
    return this.#inner.render(job);
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

let renderer: RendererConFallo;
let storage: MemoryStorage;

const clock = new FixedClock(NOW);

function handler() {
  return createContentBuildHandler({
    db: handle.db,
    renderer,
    storage,
    clock,
    appRole: APP_ROLE,
    logger: silencioso,
  });
}

/** El contexto que la cola le pasaría al handler. `maxAttempts` 3 = el del catálogo. */
const ctx = (
  payload: unknown,
  attempt = 1,
  maxAttempts = 3,
): JobContext<unknown> => ({ jobId: "job_1", payload, attempt, maxAttempts });

const jobFor = (contentId: string, revision = 1, contentType = "wall-of-text") => ({
  companyId,
  contentId,
  contentType,
  revision,
  reason: "create",
});

async function pieza(contentId: string) {
  const filas = await handle.sql`
    select status, files, thumbnail_url, revision, save_bucket, save_period,
           save_refunded_at, last_edit
    from contents where id = ${contentId}::uuid
  `;
  return filas[0] as unknown as {
    status: string;
    files: string[];
    thumbnail_url: string | null;
    revision: number;
    save_bucket: string | null;
    save_period: string | null;
    // `handle.sql` es el cliente crudo de postgres.js: acá la marca de tiempo
    // llega como venga (string u objeto), no como el `Date` que devolvería
    // Drizzle. Se tipa `unknown` y se normaliza donde se compara.
    save_refunded_at: unknown;
    last_edit: Record<string, unknown> | null;
  };
}

async function usados(): Promise<number> {
  const filas = await handle.sql`
    select content_saves_used from quota_ledgers
    where company_id = ${companyId}::uuid and period = ${PERIOD}
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
  renderer = new RendererConFallo();
  storage = new MemoryStorage(clock, "memory://bucket");
});

describe("el camino feliz", () => {
  it("construye, sube y deja la pieza en CREATED", async () => {
    const contentId = await seedPiece(handle, companyId);

    await handler()(ctx(jobFor(contentId)));

    const row = await pieza(contentId);
    expect(row.status).toBe("CREATED");
    expect(row.files).toHaveLength(1);
    // La URL guardada **no** puede llevar firma: §9.10 prohíbe persistir
    // capacidades bearer, y `canonicalObjectUrl` existe justamente para eso.
    expect(row.files[0]).not.toContain("?");
  });

  it("no toca el ledger: construir bien no devuelve nada", async () => {
    const contentId = await seedPiece(handle, companyId);
    const antes = await usados();

    await handler()(ctx(jobFor(contentId)));

    expect(await usados()).toBe(antes);
    expect((await pieza(contentId)).save_refunded_at).toBeNull();
  });

  it("la clave del objeto lleva la revisión", async () => {
    // Un rebuild no puede sobrescribir el archivo de la revisión anterior: los
    // `Post` ya programados la referencian por URL (`FR-060`).
    const contentId = await seedPiece(handle, companyId, { revision: 3 });
    await handler()(ctx(jobFor(contentId, 3)));

    const row = await pieza(contentId);
    // Se decodifica porque `MemoryStorage` mete la clave con
    // `encodeURIComponent` y las barras salen como `%2F`. Eso es del adaptador,
    // no del handler: lo que este test afirma es la **clave**, y con S3 la misma
    // aserción vale sin decodificar nada.
    expect(decodeURIComponent(row.files[0] ?? "")).toContain(`/${contentId}/3/`);
  });
});

describe("el fallo devuelve el save — FR-050", () => {
  it("marca FAILED y baja el contador", async () => {
    const contentId = await seedPiece(handle, companyId);
    const antes = await usados();
    renderer.next = new PortError("bad_request", "payload que el motor no acepta", {
      source: "MediaRenderer/test",
    });

    await handler()(ctx(jobFor(contentId)));

    const row = await pieza(contentId);
    expect(row.status).toBe("FAILED");
    expect(await usados()).toBe(antes - 1);
    expect(row.save_refunded_at).not.toBeNull();
  });

  it("deja escrito el motivo en `lastEdit`", async () => {
    const contentId = await seedPiece(handle, companyId);
    renderer.next = new PortError("bad_request", "el motor dijo que no", {
      source: "MediaRenderer/test",
    });

    await handler()(ctx(jobFor(contentId)));

    const row = await pieza(contentId);
    expect(row.last_edit).toMatchObject({ outcome: "failed" });
    expect(String(row.last_edit?.["failureReason"])).toContain("bad_request");
  });

  it("reejecutar el mismo job NO devuelve dos veces", async () => {
    // El puerto `Queue` dice que el handler puede reintentarse, así que este es
    // el caso real. Lo que lo frena, medido, es el chequeo de estado: la segunda
    // corrida encuentra la pieza en `FAILED` y ni siquiera llega al reembolso.
    // La guarda de `saveRefundedAt` está **detrás** de eso, y por eso tiene su
    // propio test abajo: si me quedara con éste, romper la guarda no pondría
    // nada en rojo y yo creería que la estoy probando.
    const contentId = await seedPiece(handle, companyId);
    const antes = await usados();

    renderer.next = new PortError("bad_request", "no", { source: "t" });
    await handler()(ctx(jobFor(contentId)));
    const despuesDelPrimero = await usados();

    renderer.next = new PortError("bad_request", "no", { source: "t" });
    await handler()(ctx(jobFor(contentId)));

    expect(despuesDelPrimero).toBe(antes - 1);
    expect(await usados()).toBe(despuesDelPrimero);
  });

  it("una pieza que ya tiene `saveRefundedAt` no se vuelve a reembolsar", async () => {
    // Esta es la guarda propiamente dicha, y hay que sembrarla a mano porque el
    // handler **no puede producir hoy** este estado: marca `FAILED` y escribe
    // `saveRefundedAt` en la misma transacción. La base sí lo permite
    // (`contents_refund_requires_bucket` sólo exige que haya bucket), y el día
    // que exista un segundo camino que reembolse —una acción de soporte, un
    // job de conciliación— esto es lo que impide que el save se devuelva dos
    // veces. Se verificó rompiéndolo: sin la guarda, este test se pone rojo.
    const contentId = await seedPiece(handle, companyId, {
      saveRefundedAt: new Date("2026-09-20T00:00:00.000Z"),
    });
    const antes = await usados();
    renderer.next = new PortError("bad_request", "no", { source: "t" });

    await handler()(ctx(jobFor(contentId)));

    const row = await pieza(contentId);
    expect(row.status).toBe("FAILED");
    expect(await usados()).toBe(antes);
    // Y la marca original no se pisa: la fecha del reembolso es la del reembolso.
    expect(new Date(row.save_refunded_at as string).toISOString()).toBe(
      "2026-09-20T00:00:00.000Z",
    );
  });

  it("una pieza sin cargo se cierra sin tocar el ledger", async () => {
    // `POST /content/custom/video` no cobra save. Reembolsar ahí regalaría cuota,
    // y el CHECK `contents_refund_requires_bucket` lo impide desde la base.
    const contentId = await seedPiece(handle, companyId, { saveBucket: null });
    const antes = await usados();
    renderer.next = new PortError("bad_request", "no", { source: "t" });

    await handler()(ctx(jobFor(contentId)));

    const row = await pieza(contentId);
    expect(row.status).toBe("FAILED");
    expect(row.save_refunded_at).toBeNull();
    expect(await usados()).toBe(antes);
  });

  it("devuelve al período del cobro, no al de hoy", async () => {
    // El reloj está en septiembre y el cargo también, así que lo que esto
    // comprueba de verdad es que el handler use `contents.savePeriod` y no
    // derive el período: derivarlo depende de `billingAnchorDay`, que puede
    // cambiar entre el cobro y el reembolso.
    const contentId = await seedPiece(handle, companyId);
    renderer.next = new PortError("bad_request", "no", { source: "t" });

    await handler()(ctx(jobFor(contentId)));

    const filas = await handle.sql`
      select count(*)::int as n from quota_ledgers where company_id = ${companyId}::uuid
    `;
    // Si hubiera derivado el período habría creado un ledger nuevo.
    expect((filas[0] as unknown as { n: number }).n).toBe(1);
    expect((await pieza(contentId)).save_period).toBe(PERIOD);
  });
});

describe("reintentos", () => {
  it("un fallo transitorio se relanza y la pieza queda en BUILDING", async () => {
    const contentId = await seedPiece(handle, companyId);
    renderer.next = new PortError("provider_unavailable", "el motor no responde", {
      source: "t",
    });

    await expect(handler()(ctx(jobFor(contentId), 1, 3))).rejects.toThrow();

    const row = await pieza(contentId);
    expect(row.status).toBe("BUILDING");
    expect(row.save_refunded_at).toBeNull();
  });

  it("en el ÚLTIMO intento no se relanza: se cierra y se devuelve el save", async () => {
    // Es el caso que este handler existe para cerrar. Relanzar también acá deja
    // la pieza en `BUILDING` cuando la cola se rinde, que es exactamente el
    // estado colgado de antes — sólo que ahora con un save cobrado.
    const contentId = await seedPiece(handle, companyId);
    const antes = await usados();
    renderer.next = new PortError("provider_unavailable", "sigue sin responder", {
      source: "t",
    });

    await handler()(ctx(jobFor(contentId), 3, 3));

    expect((await pieza(contentId)).status).toBe("FAILED");
    expect(await usados()).toBe(antes - 1);
  });

  it("un fallo permanente NO se reintenta, ni en el primer intento", async () => {
    // Un payload que no parsea no va a parsear la tercera vez. Reintentarlo sólo
    // retrasa el reembolso y ensucia la dead-letter con algo que no es un fallo
    // de infraestructura.
    const contentId = await seedPiece(handle, companyId, { buildPayload: { roto: true } });

    await handler()(ctx(jobFor(contentId), 1, 3));

    expect((await pieza(contentId)).status).toBe("FAILED");
    expect(renderer.calls).toBe(0);
  });
});

describe("carreras con la edición", () => {
  it("un job viejo no pisa una revisión más nueva", async () => {
    // La pieza va por la revisión 2 y llega el job de la 1. Construirlo
    // publicaría el render **anterior** a la edición, con la revisión nueva
    // puesta y sin ningún error.
    const contentId = await seedPiece(handle, companyId, { revision: 2 });

    await handler()(ctx(jobFor(contentId, 1)));

    const row = await pieza(contentId);
    expect(row.status).toBe("BUILDING");
    expect(row.files).toHaveLength(0);
    expect(renderer.calls).toBe(0);
  });

  it("un job viejo tampoco marca FAILED ni devuelve el save", async () => {
    const contentId = await seedPiece(handle, companyId, { revision: 2 });
    const antes = await usados();
    renderer.next = new PortError("bad_request", "no", { source: "t" });

    await handler()(ctx(jobFor(contentId, 1)));

    expect((await pieza(contentId)).status).toBe("BUILDING");
    expect(await usados()).toBe(antes);
  });

  it("una edición que entra DURANTE el render descarta el resultado", async () => {
    // La carrera de verdad: el handler leyó la revisión 1, el usuario editó y la
    // pieza va por la 2, y el render de la 1 recién termina ahora. Escribirlo
    // publicaría el render **anterior** a la edición con la revisión nueva
    // puesta, y sin ningún error. Verificado rompiéndolo: sin la comprobación de
    // `revision` al escribir, este test se pone rojo y el de "job viejo" no.
    const contentId = await seedPiece(handle, companyId);
    renderer.duranteElRender = async () => {
      await handle.sql`
        update contents set revision = 2 where id = ${contentId}::uuid
      `;
    };

    await handler()(ctx(jobFor(contentId, 1)));

    const row = await pieza(contentId);
    expect(renderer.calls).toBe(1);
    expect(row.revision).toBe(2);
    // Sigue en BUILDING porque el build de la revisión 2 todavía no corrió.
    expect(row.status).toBe("BUILDING");
    expect(row.files).toHaveLength(0);
  });

  it("y si además el render falla, NO marca FAILED ni devuelve el save", async () => {
    // El mismo caso con el render roto. Cerrar la pieza acá mataría una edición
    // que está en curso y devolvería un save que el build nuevo va a volver a
    // necesitar.
    const contentId = await seedPiece(handle, companyId);
    const antes = await usados();
    renderer.duranteElRender = async () => {
      await handle.sql`update contents set revision = 2 where id = ${contentId}::uuid`;
    };
    renderer.next = new PortError("bad_request", "no", { source: "t" });

    await handler()(ctx(jobFor(contentId, 1)));

    expect((await pieza(contentId)).status).toBe("BUILDING");
    expect(await usados()).toBe(antes);
  });

  it("una pieza ya construida no se vuelve a construir", async () => {
    const contentId = await seedPiece(handle, companyId, { status: "CREATED" });

    await handler()(ctx(jobFor(contentId)));

    expect(renderer.calls).toBe(0);
    expect((await pieza(contentId)).status).toBe("CREATED");
  });
});

describe("piezas que este handler todavía no sabe construir", () => {
  it("`custom` se cierra con un motivo en vez de quedarse en BUILDING", async () => {
    // No tienen `buildPayload` y tampoco forma de encontrar su archivo: la
    // reserva de subida no deja la `storageKey` en la fila del contenido. Dejarla
    // en `BUILDING` es el estado colgado de siempre; cerrarla al menos se ve.
    const contentId = await seedPiece(handle, companyId, {
      type: "custom",
      buildPayload: null,
      saveBucket: null,
    });

    await handler()(ctx(jobFor(contentId, 1, "custom")));

    const row = await pieza(contentId);
    expect(row.status).toBe("FAILED");
    expect(String(row.last_edit?.["failureReason"])).toContain("normalización");
  });
});

describe("payloads que no son de este mundo", () => {
  it("un payload sin `contentId` se descarta sin reintentar", async () => {
    await expect(handler()(ctx({ companyId, revision: 1 }))).resolves.toBeUndefined();
  });

  it("una pieza que no existe no es un error", async () => {
    const inventado = "00000000-0000-4000-8000-000000000000";
    await expect(handler()(ctx(jobFor(inventado)))).resolves.toBeUndefined();
  });
});

describe("aislamiento", () => {
  it("un job que apunta a la pieza de otro workspace no la toca", async () => {
    // Es el mismo `404` invisible de §9.2 bajado a la cola: con el scope del
    // workspace equivocado, la fila **no existe**. Si esto fallara, un payload
    // manipulado podría marcar FAILED la pieza de otro y devolverle el save.
    const otro = await seedCompany(handle);
    const ajena = await seedPiece(handle, otro);

    await handler()(ctx({ ...jobFor(ajena), companyId }));

    expect((await pieza(ajena)).status).toBe("BUILDING");
    expect(renderer.calls).toBe(0);
  });
});
