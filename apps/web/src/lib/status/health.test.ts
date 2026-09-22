/**
 * La frontera de `/status` · F-255, `P1-OBS-004`.
 *
 * Dos propiedades, y las dos se rompen en silencio si nadie las fija:
 *
 * 1. **Nada de `checks` cruza hacia el navegador.** Es una propiedad de
 *    seguridad, no de pantalla: se comprueba sobre el objeto **serializado**,
 *    porque "la página no lo dibuja" y "el dato no salió del servidor" son
 *    cosas distintas y sólo la segunda sirve.
 * 2. **El cuerpo manda sobre el status HTTP.** `apps/api` responde 200 con
 *    `degraded` y 503 con `unavailable`. Leer el estado del código HTTP falla
 *    en las dos direcciones, y ninguna de las dos se ve mirando la pantalla en
 *    un día normal.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError } from "../api/errors";
import {
  DEFAULT_HEALTH_URL,
  fetchServiceStatus,
  redactHealth,
  resolveHealthUrl,
} from "./health";

/** Un informe de `apps/api` tal cual lo emite `server/health.ts`. */
function report(
  status: string,
  checks: Readonly<Record<string, string>> = {
    database: "up",
    storage: "up",
    queue: "up",
  },
): Record<string, unknown> {
  return { status, service: "api", checks };
}

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Promise.resolve(
        new Response(body === undefined ? "" : JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("redactHealth · lo que NO puede salir del servidor", () => {
  it("el nombre de una dependencia no sobrevive al recorte", () => {
    const redacted = redactHealth(
      report("degraded", { database: "up", storage: "down", queue: "up" }),
    );

    // Sobre el JSON serializado a propósito: lo que importa no es qué se
    // dibuja, es qué bytes viajan. `storage: "down"` en la pestaña de red de un
    // visitante anónimo le dice qué subsistema está débil ahora mismo.
    const wire = JSON.stringify(redacted);
    expect(wire).not.toContain("storage");
    expect(wire).not.toContain("database");
    expect(wire).not.toContain("queue");
    expect(wire).not.toContain("down");
    // Y el estado sí llega, que es para lo que existe la página.
    expect(redacted).toEqual({ state: "degraded" });
  });

  it("tampoco sale `service`, ni ninguna clave que alguien agregue arriba", () => {
    const redacted = redactHealth({
      ...report("ok"),
      version: "1.4.2",
      commit: "b16ff18",
      region: "eu-west-1",
    });

    expect(redacted).toEqual({ state: "ok" });
    expect(Object.keys(redacted ?? {})).toEqual(["state"]);
  });

  it("un cuerpo que no es un informe es `null`, y `null` NO es sano", () => {
    // Lo que se evita es reinventar la mentira original de `/health`: una
    // constante con forma de URL que no puede decir que algo va mal.
    expect(redactHealth({ ok: true })).toBeNull();
    expect(redactHealth({ status: "fine" })).toBeNull();
    expect(redactHealth("ok")).toBeNull();
    expect(redactHealth(null)).toBeNull();
    expect(redactHealth(undefined)).toBeNull();
  });

  it("los tres estados del contrato pasan tal cual", () => {
    expect(redactHealth(report("ok"))).toEqual({ state: "ok" });
    expect(redactHealth(report("degraded"))).toEqual({ state: "degraded" });
    expect(redactHealth(report("unavailable"))).toEqual({ state: "unavailable" });
  });
});

describe("resolveHealthUrl · a quién se le pregunta", () => {
  it("la variable explícita gana", () => {
    expect(
      resolveHealthUrl({
        FASTGRAM_HEALTH_URL: "https://api.example.test/fastgram/health",
        FASTGRAM_API_URL: "https://api.example.test/fastgram/api/v1",
      }),
    ).toBe("https://api.example.test/fastgram/health");
  });

  it("sin ella, se deriva del ORIGEN de la API — `/health` no va bajo `/api/v1`", () => {
    // `apps/api` monta `/health` en la raíz del servidor, fuera del prefijo de
    // versión: quedarse con el path de `FASTGRAM_API_URL` pediría
    // `/api/v1/health`, que es un 404 que se leería como "servicio caído".
    expect(
      resolveHealthUrl({ FASTGRAM_API_URL: "http://api.internal:3001/api/v1" }),
    ).toBe("http://api.internal:3001/health");
  });

  it("sin nada configurado, el default de desarrollo", () => {
    expect(resolveHealthUrl({})).toBe(DEFAULT_HEALTH_URL);
    expect(resolveHealthUrl({ FASTGRAM_API_URL: "  " })).toBe(DEFAULT_HEALTH_URL);
  });

  it("una configuración que no es una URL http(s) es `null`, no un default silencioso", () => {
    // Si esto cayera al default, un despliegue con la variable mal puesta
    // sondearía `localhost` y diría que el servicio está perfecto.
    expect(resolveHealthUrl({ FASTGRAM_API_URL: "no-soy-una-url" })).toBeNull();
    expect(resolveHealthUrl({ FASTGRAM_HEALTH_URL: "file:///etc/passwd" })).toBeNull();
    expect(resolveHealthUrl({ FASTGRAM_HEALTH_URL: "javascript:alert(1)" })).toBeNull();
  });
});

describe("fetchServiceStatus · el cuerpo manda, no el status HTTP", () => {
  it("200 con `degraded` es `degraded`, NO `ok`", async () => {
    // El caso que motiva medio archivo: `apps/api` devuelve **200** con storage
    // o cola caídos a propósito, para no sacar la réplica de rotación. Quien
    // lea `response.ok` dirá "todo bien" con el storage muerto.
    respondWith({ state: "degraded" }, 200);
    await expect(fetchServiceStatus()).resolves.toEqual({ state: "degraded" });
  });

  it("503 con `unavailable` es un informe válido, NO un fallo de red", async () => {
    // El error simétrico y menos obvio: un `if (!response.ok) throw` convertiría
    // el informe más importante de los tres en "no se pudo contactar al
    // servidor", que es un mensaje distinto y peor.
    respondWith({ state: "unavailable" }, 503);
    await expect(fetchServiceStatus()).resolves.toEqual({ state: "unavailable" });
  });

  it("200 con `ok` es `ok`", async () => {
    respondWith({ state: "ok" }, 200);
    await expect(fetchServiceStatus()).resolves.toEqual({ state: "ok" });
  });

  it("un cuerpo con claves de más se rechaza: `checks` no puede volver sin que nadie lo note", async () => {
    // `.strict()`. Si alguien "mejorara" el handler reenviando el cuerpo
    // entero, esto falla acá en vez de publicar el desglose en silencio.
    respondWith({ state: "degraded", checks: { storage: "down" } }, 200);
    await expect(fetchServiceStatus()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("si no hubo respuesta, es un error de red y no un estado", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))),
    );
    const failure = await fetchServiceStatus().catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(ApiRequestError);
    expect(failure).toMatchObject({ code: "network_error", status: 0 });
  });

  it("un cuerpo que no es JSON es `invalid_response`", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Promise.resolve(new Response("<html>502</html>", { status: 502 })),
      ),
    );
    await expect(fetchServiceStatus()).rejects.toMatchObject({
      code: "invalid_response",
      status: 502,
    });
  });

  it("un sobre de error de nuestro propio handler no se lee como un estado", async () => {
    respondWith(
      {
        error: {
          code: "service_unavailable",
          message: "The status check did not respond.",
        },
      },
      502,
    );
    await expect(fetchServiceStatus()).rejects.toMatchObject({
      code: "service_unavailable",
      status: 502,
    });
  });
});
