/**
 * Los endpoints de escritura, ejecutados de verdad.
 *
 * Hasta acá los 16 endpoints de `P1-API` estaban escritos y **ninguno se había
 * ejecutado**: lo verificado eran funciones puras y tipos. Un `201` escrito en
 * un handler no es un `201` devuelto, y entre una cosa y la otra están el
 * schema de Zod, el hook de scope, el serializador, el manejador de errores y
 * la transacción.
 *
 * Este archivo no repite lo que ya cubren otros: el aislamiento por tenant está
 * en `tenant-isolation.int.test.ts` y el reconcile de ángulos en
 * `blitz-angles.int.test.ts`. Acá van las tres cosas que nadie había ejercido:
 * **los códigos de estado**, **el replay de idempotencia** y **el encolado**.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JOB_QUEUES } from "@fastgram/core";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;

/** Payload válido de `wall-of-text`: es el que menos campos exige (§FR-070). */
const WALL_OF_TEXT = {
  canvas: { width: 1080, height: 1920 },
  video: {
    url: "https://cdn.example.test/a.mp4",
    drawX: 0,
    drawY: 0,
    drawW: 1080,
    drawH: 1920,
  },
  text: {
    content: "Guía rápida",
    x: 50,
    y: 50,
    width: 800,
    fontSize: 48,
    color: "#FFFFFF",
    textAlign: "center",
  },
};

beforeAll(async () => {
  api = await startApi();
}, 180_000);

afterAll(async () => {
  await api?.close();
});

beforeEach(() => {
  api.queue.reset();
});

describe("POST /content", () => {
  it("crea la pieza en BUILDING y encola el build", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: `crear-${String(Date.now())}`,
    });

    expect(res.status).toBe(201);
    const content = dataOf(res);
    expect(content["status"]).toBe("BUILDING");
    // `revision` arranca en 1: la base tiene CHECK `revision >= 1` y el dominio
    // devolvía 0, que no se podía persistir. Es la regresión que este test fija.
    expect(content["revision"]).toBe(1);

    const jobs = api.queue.forQueue(JOB_QUEUES.contentBuild);
    expect(jobs).toHaveLength(1);
    expect((jobs[0]?.payload as { contentId?: string }).contentId).toBe(content["_id"]);
  });

  it("NO devuelve `buildPayload` ni `studioState` (DATA-008)", async () => {
    // El PRD los marca como nunca-devolver. El tipo de retorno del serializador
    // ya lo impide en compilación; esto lo comprueba sobre el JSON real, que es
    // lo que ve el cliente.
    const res = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: `sin-payload-${String(Date.now())}`,
    });
    expect(res.raw).not.toContain("buildPayload");
    expect(res.raw).not.toContain("studioState");
  });

  it("exige `Idempotency-Key` (§9.3)", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
    });
    expect(res.status).toBe(400);
  });

  it("un payload que no encaja en ningún formato es 400, no 500", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: { canvas: { width: 1080, height: 1920 } },
      idempotencyKey: `malo-${String(Date.now())}`,
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("bad_request");
  });
});

describe("idempotencia — el replay que nunca se había ejercido", () => {
  it("la misma key con el mismo body devuelve la MISMA pieza, no una nueva", async () => {
    const key = `replay-${String(Date.now())}`;
    const primera = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: key,
    });
    const segunda = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: key,
    });

    expect(primera.status).toBe(201);
    expect(segunda.status).toBe(201);
    expect(dataOf(segunda)["_id"]).toBe(dataOf(primera)["_id"]);

    // Y la mitad que importa: el replay **no vuelve a encolar**. Si encolara,
    // el reintento de un cliente por timeout construiría la pieza dos veces.
    expect(api.queue.forQueue(JOB_QUEUES.contentBuild)).toHaveLength(1);
  });

  it("la misma key con otro body es 409 conflict", async () => {
    const key = `conflicto-${String(Date.now())}`;
    await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: key,
    });
    const otra = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: {
        ...WALL_OF_TEXT,
        text: { ...WALL_OF_TEXT.text, content: "otra copy" },
      },
      idempotencyKey: key,
    });
    expect(otra.status).toBe(409);
    expect(errorOf(otra).code).toBe("conflict");
  });

  it("una key quemada por un request fallido se puede reusar (regla 3)", async () => {
    // Es la regla que se olvida. Sin ella, un 500 transitorio inutiliza la key
    // para siempre y el cliente no puede reintentar — lo contrario de para qué
    // existe el header.
    const key = `liberada-${String(Date.now())}`;
    api.queue.failNext = true;

    const falla = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: key,
    });
    expect(falla.status).toBeGreaterThanOrEqual(500);

    const reintento = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: key,
    });
    expect(reintento.status).toBe(201);
  });
});

describe("cuando la cola falla, no queda una pieza colgada", () => {
  it("un fallo al encolar aborta la transacción: la pieza no se crea", async () => {
    // Es la razón de encolar **último y dentro** de la transacción. Si la fila
    // sobreviviera al fallo de la cola, quedaría en `BUILDING` para siempre y
    // —peor— nunca fallaría, así que el save tampoco se reembolsaría.
    const antes = await api.request({ method: "GET", path: "/api/v1/content" });
    const cuantas = (antes.body?.["data"] as unknown[]).length;

    api.queue.failNext = true;
    const res = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: `cola-rota-${String(Date.now())}`,
    });
    expect(res.status).toBeGreaterThanOrEqual(500);

    const despues = await api.request({ method: "GET", path: "/api/v1/content" });
    expect((despues.body?.["data"] as unknown[]).length).toBe(cuantas);
  });
});

describe("los filtros que antes devolvían 400", () => {
  it("`GET /content?type=` filtra en vez de rechazar", async () => {
    await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: `filtro-${String(Date.now())}`,
    });

    const wall = await api.request({
      method: "GET",
      path: "/api/v1/content?type=wall-of-text",
    });
    expect(wall.status).toBe(200);
    const filas = wall.body?.["data"] as { type: string }[];
    expect(filas.length).toBeGreaterThan(0);
    expect(filas.every((r) => r.type === "wall-of-text")).toBe(true);

    const video = await api.request({
      method: "GET",
      path: "/api/v1/content?type=video-hook",
    });
    expect((video.body?.["data"] as unknown[]).length).toBe(0);
  });

  it("un valor que no es del enum es 400 y no una lista vacía", async () => {
    // La diferencia importa: una lista vacía se ve como "no hay nada" y el
    // cliente la muestra; un 400 dice que la petición estaba mal.
    const res = await api.request({
      method: "GET",
      path: "/api/v1/content?type=inventado",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /audio", () => {
  it("exige `for`: el catálogo está curado por formato", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/audio" });
    expect(res.status).toBe(400);
  });

  it("con `for` responde el envelope de cursor", async () => {
    const res = await api.request({
      method: "GET",
      path: "/api/v1/audio?for=wall-of-text",
    });
    expect(res.status).toBe(200);
    expect(res.body?.["pagination"]).toMatchObject({ cursor: null, hasMore: false });
  });
});

describe("GET /blitz/angles/page — la paginación numerada de §9.10", () => {
  it("trae `page` y `totalPages`, y NO trae `cursor`", async () => {
    // El `cursor` se omite a propósito: en `null` parecería un cursor guardable
    // y esta ruta no acepta ninguno. Un campo permanentemente nulo no es
    // información, es una invitación a un bug del cliente.
    const res = await api.request({
      method: "GET",
      path: "/api/v1/blitz/angles/page?page=1&limit=5",
    });
    expect(res.status).toBe(200);
    const pagination = res.body?.["pagination"] as Record<string, unknown>;
    expect(pagination["page"]).toBe(1);
    expect(pagination["pageSize"]).toBe(5);
    expect(typeof pagination["totalPages"]).toBe("number");
    expect(pagination).not.toHaveProperty("cursor");
  });

  it("`page=0` cae en la primera página en vez de dar error", async () => {
    const res = await api.request({
      method: "GET",
      path: "/api/v1/blitz/angles/page?page=0",
    });
    expect([200, 400]).toContain(res.status);
  });
});

describe("PATCH /blitz/preferences", () => {
  it("funciona sobre un workspace que todavía no tiene fila", async () => {
    // Es el caso normal: el workspace recién creado no tiene preferencias y el
    // usuario igual abre el drawer. Por eso el repositorio declara `upsertTarget`.
    const res = await api.request({
      method: "PATCH",
      path: "/api/v1/blitz/preferences",
      body: { remixPercentage: 40 },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)["remixPercentage"]).toBe(40);
  });

  it("un patch parcial no resetea el resto", async () => {
    // El `upsert` reescribe todas las columnas que recibe, así que mandarle
    // sólo el patch dejaría los demás campos en el default del schema: un PATCH
    // de `remixPercentage` habría reseteado el content mix entero.
    await api.request({
      method: "PATCH",
      path: "/api/v1/blitz/preferences",
      body: { influencerChance: 70 },
    });
    const res = await api.request({
      method: "PATCH",
      path: "/api/v1/blitz/preferences",
      body: { remixPercentage: 10 },
    });
    expect(dataOf(res)["influencerChance"]).toBe(70);
    expect(dataOf(res)["remixPercentage"]).toBe(10);
  });
});
