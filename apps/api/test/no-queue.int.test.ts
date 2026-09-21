/**
 * La app **sin** cola montada — el camino degradado, que es un camino real.
 *
 * `ApiDeps.queue` es opcional porque hay entornos donde no está: los tests de
 * ruta que no la necesitan, y un despliegue mal configurado. Lo que hace
 * interesante este archivo es que la respuesta correcta no es "seguí sin
 * encolar": una pieza creada en `BUILDING` sin job **queda colgada para
 * siempre y nunca falla**, así que tampoco dispara el reembolso del save. Es
 * peor que fallar.
 *
 * Por eso esas rutas responden `503 service_unavailable` —código del PRD— y
 * **no escriben nada**. Eso último es lo que este archivo verifica, porque es
 * lo que un `503` escrito a mano en un handler no garantiza por sí solo: la
 * fila puede haberse creado antes del chequeo.
 *
 * Va en su propio archivo porque `startApi` siembra la base desde cero; dos
 * arneses en el mismo archivo se pisarían los datos a mitad de corrida.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;

const WALL_OF_TEXT = {
  canvas: { width: 1080, height: 1920 },
  video: { url: "https://cdn.example.test/a.mp4", drawX: 0, drawY: 0, drawW: 1080, drawH: 1920 },
  text: {
    content: "Sin cola",
    x: 50,
    y: 50,
    width: 800,
    fontSize: 48,
    color: "#FFFFFF",
    textAlign: "center",
  },
};

beforeAll(async () => {
  api = await startApi({ withQueue: false });
}, 180_000);

afterAll(async () => {
  await api?.close();
});

describe("POST /content sin cola", () => {
  it("responde 503 service_unavailable, no 500", async () => {
    // `service_unavailable` es un código del PRD (§19, `ERR-R06`). Un 500 diría
    // "bug nuestro" y haría que el cliente no reintente; un 503 es transitorio
    // por contrato.
    const res = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: "sin-cola-1",
    });
    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe("service_unavailable");
  });

  it("y NO deja la pieza creada", async () => {
    // Ésta es la mitad que un 503 no garantiza solo. Si la fila sobreviviera,
    // quedaría en `BUILDING` sin job: invisible como error y permanente.
    const antes = await api.request({ method: "GET", path: "/api/v1/content" });
    const cuantas = (antes.body?.["data"] as unknown[]).length;

    await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: "sin-cola-2",
    });

    const despues = await api.request({ method: "GET", path: "/api/v1/content" });
    expect((despues.body?.["data"] as unknown[]).length).toBe(cuantas);
  });

  it("la `Idempotency-Key` queda libre para reintentar cuando la cola vuelva", async () => {
    // Un 503 es transitorio por definición. Si quemara la key, el cliente que
    // reintenta cuando el servicio se recupera recibiría un 409 para siempre.
    const key = "sin-cola-3";
    const primera = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: key,
    });
    expect(primera.status).toBe(503);

    const segunda = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: key,
    });
    // Sigue sin cola, así que vuelve a ser 503 — lo que importa es que **no**
    // sea 409: la key no se quemó.
    expect(segunda.status).toBe(503);
  });
});

describe("lo que no depende de la cola sigue andando", () => {
  it("`GET /content` responde 200", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/content" });
    expect(res.status).toBe(200);
  });

  it("`PATCH /blitz/preferences` responde 200: no encola nada", async () => {
    const res = await api.request({
      method: "PATCH",
      path: "/api/v1/blitz/preferences",
      body: { remixPercentage: 25 },
    });
    expect(res.status).toBe(200);
  });
});
