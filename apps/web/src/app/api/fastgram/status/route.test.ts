/**
 * El route handler que redacta el health check · `P1-OBS-004`.
 *
 * `lib/status/health.test.ts` prueba las piezas; esto prueba **el cable**, que
 * es donde las dos propiedades de la tarea se pueden romper de verdad:
 *
 * 1. Lo que sale por el socket no nombra ninguna dependencia interna. Se
 *    comprueba sobre el **texto de la respuesta**, no sobre un objeto: es lo
 *    que un visitante anónimo ve en la pestaña de red.
 * 2. Un `503` de `apps/api` trae el informe `unavailable`, y este handler tiene
 *    que leerlo en vez de tratarlo como "no hubo respuesta".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

/** Un informe completo de `apps/api` (`server/health.ts`). */
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

function upstreamAnswers(body: unknown, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    ),
  );
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  // El handler lee `process.env` directamente porque es el contrato de una
  // ruta de Next. Se fija acá para que el test no dependa del `.env` de quien
  // lo corra.
  process.env["FASTGRAM_HEALTH_URL"] = "http://api.internal:3001/health";
  // Los `console.error` del handler son deliberados —el motivo real va al log,
  // nunca al cable— pero ensucian la salida de la suite.
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  process.env = { ...ORIGINAL_ENV };
});

describe("lo que cruza hacia un visitante anónimo", () => {
  it("con una dependencia caída dice `degraded` y NO dice cuál", async () => {
    upstreamAnswers(
      report("degraded", { database: "up", storage: "down", queue: "up" }),
      200,
    );

    const response = await GET();
    const text = await response.text();

    // Primero lo que no puede estar. Con la aserción positiva delante, un fallo
    // diría "esperaba degraded" en vez de "se publicó el nombre de la
    // dependencia caída", y quien lo lea buscaría en el lugar equivocado.
    for (const secret of ["storage", "database", "queue", "down", "checks", "api"]) {
      expect(text).not.toContain(secret);
    }
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ state: "degraded" });
  });

  it("un 503 del health check es un informe, no un silencio", async () => {
    // `apps/api` saca la réplica de rotación cuando Postgres está abajo: 503
    // **con** cuerpo. Tratar el `!ok` como "no hubo respuesta" perdería el
    // único informe que de verdad importa enseñar.
    upstreamAnswers(
      report("unavailable", { database: "down", storage: "up", queue: "up" }),
      503,
    );

    const response = await GET();
    const text = await response.text();

    expect(text).not.toContain("database");
    // La página sí tiene que poder decir "caído": lo que se responde es 200 con
    // el estado dentro, porque **este** endpoint sí contestó.
    expect(response.status).toBe(200);
    expect(JSON.parse(text)).toEqual({ state: "unavailable" });
  });

  it("todo arriba es `ok`", async () => {
    upstreamAnswers(report("ok"), 200);

    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ state: "ok" });
  });

  it("la respuesta se puede cachear un rato, y el fallo no", async () => {
    // Una página de estado pública es un amplificador: la abre todo el mundo
    // justo cuando algo va mal, y cada visita sondearía Postgres, R2 y la cola.
    upstreamAnswers(report("ok"), 200);
    const ok = await GET();
    expect(ok.headers.get("cache-control")).toBe("public, max-age=5");

    // El fallo es el estado que más rápido cambia: congelarlo delante de un CDN
    // sería enseñar una caída que ya pasó, o esconder una que empezó.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))),
    );
    const failed = await GET();
    expect(failed.headers.get("cache-control")).toBe("no-store");
  });
});

describe("cuando no se puede saber, se dice que no se sabe", () => {
  it("si el health check no responde, un 502 con el sobre de §9.3", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new Error("connect ECONNREFUSED 10.0.0.4:3001"))),
    );

    const response = await GET();
    const text = await response.text();

    // El mensaje del error lleva host y puerto internos: no se reenvía.
    expect(text).not.toContain("10.0.0.4");
    expect(text).not.toContain("ECONNREFUSED");
    expect(response.status).toBe(502);
    expect(JSON.parse(text)).toMatchObject({
      error: { code: "service_unavailable" },
    });
  });

  it("un cuerpo que no es un informe NO se convierte en `ok`", async () => {
    // El bug que este handler existe para no repetir: `/health` devolvía
    // `{status:"ok"}` literal, o sea una constante que no podía fallar. Si un
    // cuerpo irreconocible cayera del lado sano, la página volvería a ser eso.
    upstreamAnswers({ hello: "world" }, 200);

    const response = await GET();
    const body: unknown = await response.json();

    expect(body).not.toMatchObject({ state: "ok" });
    expect(response.status).toBe(502);
    expect(body).toMatchObject({ error: { code: "service_unavailable" } });
  });

  it("sin una URL de health válida responde 503, no `ok`", async () => {
    delete process.env["FASTGRAM_HEALTH_URL"];
    process.env["FASTGRAM_API_URL"] = "no-soy-una-url";
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const response = await GET();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "service_unavailable" },
    });
    // Y no se intentó pedir nada: una URL mal formada no se "prueba a ver".
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("cómo se pregunta", () => {
  it("no manda credencial: `/health` no lleva auth y la API key no pinta acá", async () => {
    upstreamAnswers(report("ok"), 200);

    await GET();

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    expect(call?.[0]).toBe("http://api.internal:3001/health");
    const headers = (call?.[1]?.headers ?? {}) as Record<string, string>;
    // Mandar la key del workspace a un endpoint público no compra nada y regala
    // superficie: cualquiera puede llamar a `/health` sin ella.
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain(
      "authorization",
    );
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain("cookie");
  });

  it("la petición lleva timeout: una sonda colgada es peor que un error", async () => {
    upstreamAnswers(report("ok"), 200);

    await GET();

    const init = vi.mocked(globalThis.fetch).mock.calls[0]?.[1];
    expect(init?.signal).toBeDefined();
    expect(init?.cache).toBe("no-store");
  });
});
