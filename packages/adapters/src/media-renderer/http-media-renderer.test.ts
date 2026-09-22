import { describe, expect, it } from "vitest";
import {
  describeMediaRendererContract,
  isPortError,
  type Clock,
  type MediaAuthorization,
  type RenderJob,
  type RenderText,
  type SlideshowJob,
  type WallOfTextJob,
} from "@fastgram/ports";
import {
  fetchRenderEngineVersion,
  HttpMediaRenderer,
  type RenderFetch,
} from "./http-media-renderer.js";
import { FixedClock } from "../clock/index.js";
import {
  ALL_JOBS,
  GREEN_SCREEN,
  SLIDESHOW,
  SLIDESHOW_ONE,
  TEXT,
  VIDEO_HOOK,
  WALL_OF_TEXT,
} from "./__tests__/jobs.js";

/**
 * Autorización que cubre la media de los jobs de `__tests__/jobs.ts`.
 *
 * Los prefijos son los de esas URLs a propósito: el grant que el adaptador
 * firma con esto es el que un servicio real verificaría, así que si alguien
 * cambia una URL de los jobs sin tocar esto, lo correcto es que el test de
 * integración contra `services/render` se ponga rojo.
 */
const AUTH: MediaAuthorization = {
  companyId: "com_prueba",
  mediaPrefixes: ["https://media.test/"],
  sharedPrefixes: ["https://library.test/"],
};

/**
 * `HttpMediaRenderer` — `P2-RENDER-002`.
 *
 * Dos mitades, y las dos hacen falta:
 *
 * 1. **Un `fetch` falso.** Cubre lo que no se puede verificar con el servicio
 *    arriba porque haría falta romperlo a propósito: cada código de error
 *    traducido con su clasificación de reintento, el vencimiento del timeout,
 *    el stream que se cuelga, el artefacto truncado, el `href` raro. Estos
 *    casos corren siempre, en cualquier máquina y en CI.
 * 2. **La suite de contrato del puerto contra `services/render` de verdad.** Se
 *    saltea sola si el servicio no está levantado, **con el motivo en el nombre
 *    de cada caso**: una suite que se saltea en silencio es cobertura que nadie
 *    corre.
 *
 * Para correr la mitad 2 hace falta, además del servicio en `RENDER_BASE_URL`:
 *
 *   RENDER_TEST_IMAGE_URL / RENDER_TEST_VIDEO_URL / RENDER_TEST_AUDIO_URL
 *     media alcanzable de verdad. Sin media real un renderer no se puede
 *     verificar, y por eso la suite prefiere saltearse a mentir.
 *   RENDER_ALLOWED_MEDIA_PREFIXES + RENDER_SHARED_LIBRARY_PREFIXES del lado del
 *     servicio, cubriendo esas URLs (el audio **sólo** desde los compartidos).
 *   Ya no hace falta RENDER_REQUIRE_GRANT=false. El puerto transporta una
 *     `MediaAuthorization` y el adaptador la firma (`media-grant.ts`), así que
 *     el servicio puede quedarse con su postura por defecto —sin grant no se
 *     renderiza—, que es la que sostiene el aislamiento de `NFR-006`.
 */

/* ------------------------------------------------------------------------ *
 * Servicio falso
 * ------------------------------------------------------------------------ */

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

function recorder(handler: (call: Recorded) => Response | Promise<Response>): {
  fetch: RenderFetch;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  return {
    calls,
    fetch: async (url, init) => {
      const call = { url, method: init.method, body: init.body };
      calls.push(call);
      return handler(call);
    },
  };
}

const BODY = new TextEncoder().encode("bytes que pretenden ser un mp4");
const HREF = "/artifact/9f2a/final.mp4";

function json(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function artifactResponse(
  bytes: Uint8Array = BODY,
  contentType: string | null = "video/mp4",
  declaredLength: number | null = bytes.byteLength,
): Response {
  const headers: Record<string, string> = {};
  if (contentType !== null) headers["content-type"] = contentType;
  if (declaredLength !== null) headers["content-length"] = String(declaredLength);
  return new Response(bytes, { status: 200, headers });
}

/** Lo que `POST /probe` devuelve para un MOV vertical sano. */
const PROBE_OK = {
  contentType: "video/quicktime",
  width: 1080,
  height: 1920,
  durationSeconds: 12.5,
  hasAudio: true,
  isHdr: false,
  isFastStart: false,
};

/**
 * Lo que `/normalize` y `/thumbnail` devuelven. El campo del tamaño es
 * `sizeBytes` —**no** `bytes`, como en los artefactos de `/render`—; son dos
 * formas distintas del mismo servicio, y confundirlas es un bug silencioso.
 */
const DESCRIBED_OK = {
  contentType: "video/mp4",
  sizeBytes: BODY.byteLength,
  width: 1080,
  height: 1920,
  durationSeconds: 12.5,
  href: HREF,
};

interface FakeOptions {
  readonly warnings?: readonly string[];
  readonly probe?: unknown;
  readonly described?: unknown;
  readonly artifacts?: readonly unknown[];
  readonly artifact?: () => Response;
  readonly type?: string;
}

/**
 * Un servicio que responde bien, derivando el `type` del payload recibido.
 *
 * Sirve el `content-type` que corresponde al `kind` que declaró —`image/jpeg`
 * para los slides, `video/mp4` para lo demás—, porque el adaptador cruza las
 * dos cosas. Un doble incoherente hacía fallar el caso del slideshow de un
 * slide: lo detectó la propia comprobación, que es la mejor señal de que sirve.
 */
function fakeService(options: FakeOptions = {}): {
  fetch: RenderFetch;
  calls: Recorded[];
} {
  let servedKind: "video" | "image" = "video";
  return recorder((call) => {
    if (call.url.endsWith("/render")) {
      const parsed = JSON.parse(call.body ?? "{}") as {
        payload?: { type?: string; slides?: unknown[] };
      };
      const type = options.type ?? parsed.payload?.type ?? "?";
      const slides = parsed.payload?.slides;
      servedKind = Array.isArray(slides) ? "image" : "video";
      const artifacts =
        options.artifacts ??
        (Array.isArray(slides)
          ? slides.map((_slide, index) => ({
              kind: "image",
              index,
              bytes: BODY.byteLength,
              href: `${HREF}-${String(index)}`,
            }))
          : [{ kind: "video", index: 0, bytes: BODY.byteLength, href: HREF }]);

      return json(200, {
        type,
        keys: { mediaKey: "m1", overlayKey: "o1", buildKey: "b1" },
        cache: { base: "miss", build: "miss" },
        warnings: options.warnings ?? [],
        artifacts,
      });
    }
    if (call.url.endsWith("/probe")) {
      return json(200, options.probe ?? PROBE_OK);
    }
    if (call.url.endsWith("/normalize") || call.url.endsWith("/thumbnail")) {
      servedKind = call.url.endsWith("/thumbnail") ? "image" : "video";
      return json(200, options.described ?? DESCRIBED_OK);
    }
    if (call.url.includes("/artifact/")) {
      return options.artifact === undefined
        ? artifactResponse(BODY, servedKind === "image" ? "image/jpeg" : "video/mp4")
        : options.artifact();
    }
    return json(404, { error: { code: "not_found", message: "?", details: {} } });
  });
}

function makeRenderer(
  fetchLike: RenderFetch,
  overrides: {
    timeoutMs?: number;
    idleTimeoutMs?: number;
    grantSecret?: string;
    grantTtlMs?: number;
    clock?: Clock;
  } = {},
): HttpMediaRenderer {
  return new HttpMediaRenderer({
    baseUrl: "http://render.internal:3002",
    engineVersion: "ffmpeg-7.1+text-sharp-overlay",
    fetch: fetchLike,
    ...overrides,
  });
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<number> {
  let total = 0;
  for await (const chunk of body) total += chunk.byteLength;
  return total;
}

async function thrownBy(body: () => Promise<unknown>): Promise<unknown> {
  try {
    await body();
  } catch (error) {
    return error;
  }
  throw new Error("no lanzó nada");
}

/* ------------------------------------------------------------------------ *
 * Camino feliz
 * ------------------------------------------------------------------------ */

describe("HttpMediaRenderer — el build completo contra un servicio falso", () => {
  it("POST /render lleva el payload envuelto en `payload`", async () => {
    const service = fakeService();
    await makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH);

    const post = service.calls[0];
    expect(post?.url).toBe("http://render.internal:3002/render");
    expect(post?.method).toBe("POST");
    // El envoltorio es parte del contrato acordado con `services/render`
    // (`renderRequestSchema` es `{payload, grant?}`): mandar el payload pelado
    // da `bad_request` sobre un payload válido.
    expect(JSON.parse(post?.body ?? "{}")).toEqual({
      payload: expect.objectContaining({ type: "wall-of-text" }),
    });
  });

  it("devuelve el artefacto con su content type, tamaño y dimensiones", async () => {
    const renderer = makeRenderer(fakeService().fetch);
    const result = await renderer.render(WALL_OF_TEXT, AUTH);

    expect(result.contentType).toBe("video/mp4");
    expect(result.sizeBytes).toBe(BODY.byteLength);
    // Las dimensiones salen del canvas pedido: el servicio no las devuelve.
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1920);
    expect(result.fingerprint).toBe(renderer.fingerprint(WALL_OF_TEXT));
    expect(result.renderMs).toBeGreaterThanOrEqual(0);
  });

  it("el body se consume en streaming y entrega lo que declaró", async () => {
    const result = await makeRenderer(fakeService().fetch).render(WALL_OF_TEXT, AUTH);

    expect(await drain(result.body)).toBe(result.sizeBytes);
  });

  it("pide el href tal cual, concatenado al base URL y sin parsearlo", async () => {
    // `href` es opaco. Un adaptador que lo reconstruyera —tomando el último
    // segmento, o `decodeURIComponent`— rompería el día que el servidor cambie
    // su forma interna, que es justo lo que «opaco» promete que puede pasar.
    const raro = "/artifact/a%2Fb/../x?v=1&k=2";
    const service = fakeService({
      artifacts: [{ kind: "video", index: 0, bytes: BODY.byteLength, href: raro }],
    });

    await makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH);

    expect(service.calls[1]?.url).toBe(`http://render.internal:3002${raro}`);
    expect(service.calls[1]?.method).toBe("GET");
  });

  it("los warnings del servicio llegan a quien los pueda loguear", async () => {
    // Sin este gancho se perderían: `RenderResult` no tiene dónde ponerlos, y
    // «se renderizó con una fuente no verificada» es exactamente la trampa 6
    // —una pieza con la tipografía equivocada y sin rastro en ningún log—.
    const vistos: string[][] = [];
    const renderer = new HttpMediaRenderer({
      baseUrl: "http://render.internal:3002",
      engineVersion: "v1",
      fetch: fakeService({ warnings: ["slide 0: fuente no verificada"] }).fetch,
      onWarnings: (warnings) => {
        vistos.push([...warnings]);
      },
    });

    await renderer.render(WALL_OF_TEXT, AUTH);

    expect(vistos).toEqual([["slide 0: fuente no verificada"]]);
  });

  it("renderAll expone las claves de cache del servicio como diagnóstico", async () => {
    const build = await makeRenderer(fakeService().fetch).renderAll(WALL_OF_TEXT, AUTH);

    expect(build.keys).toEqual({ mediaKey: "m1", overlayKey: "o1", buildKey: "b1" });
    expect(build.cache).toEqual({ base: "miss", build: "miss" });
    // Y no se confunden con el fingerprint del adaptador: son otra cosa.
    expect(build.fingerprint).not.toBe(build.keys["buildKey"]);
  });

  it("un campo de diagnóstico con forma rara no tira abajo un render que salió bien", async () => {
    // Estricto con lo que el build necesita, tolerante con lo informativo:
    // fallar un render que salió bien por la forma de `keys` o `warnings` sería
    // cobrarle al usuario un bug de observabilidad.
    const renderer = new HttpMediaRenderer({
      baseUrl: "http://render.internal:3002",
      engineVersion: "v1",
      fetch: recorder((call) =>
        call.url.endsWith("/render")
          ? json(200, {
              type: "wall-of-text",
              keys: "esto no es un objeto",
              cache: 42,
              warnings: "tampoco es una lista",
              artifacts: [
                { kind: "video", index: 0, bytes: BODY.byteLength, href: HREF },
              ],
            })
          : artifactResponse(),
      ).fetch,
    });

    const build = await renderer.renderAll(WALL_OF_TEXT, AUTH);

    expect(build.keys).toEqual({});
    expect(build.warnings).toEqual([]);
    expect(build.artifacts).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------ *
 * Slideshow: N artefactos contra un puerto que transporta uno
 * ------------------------------------------------------------------------ */

describe("HttpMediaRenderer — el slideshow no entra en RenderResult", () => {
  it("renderAll devuelve los N artefactos", async () => {
    const build = await makeRenderer(fakeService().fetch).renderAll(SLIDESHOW, AUTH);

    expect(build.artifacts.map((a) => a.href)).toEqual([`${HREF}-0`, `${HREF}-1`]);
    expect(build.artifacts.every((a) => a.kind === "image")).toBe(true);
  });

  it("render falla claro en vez de devolver el primer slide", async () => {
    // Devolver el primero produciría un slideshow de una imagen, publicado, sin
    // ningún error en ningún log: es el «slideshow corto sin avisar» de
    // `FR-070` con otro disfraz.
    const error = await thrownBy(() =>
      makeRenderer(fakeService().fetch).render(SLIDESHOW, AUTH),
    );

    expect(error).toMatchObject({
      name: "PortError",
      code: "provider_contract_violation",
    });
    expect(String(error)).toMatch(/2 artifacts/);
  });

  it("un slideshow con menos artefactos que slides es una violación de contrato", async () => {
    const service = fakeService({
      artifacts: [{ kind: "image", index: 0, bytes: BODY.byteLength, href: HREF }],
    });

    const error = await thrownBy(() =>
      makeRenderer(service.fetch).renderAll(SLIDESHOW, AUTH),
    );

    expect(error).toMatchObject({
      name: "PortError",
      code: "provider_contract_violation",
    });
    expect(String(error)).toMatch(/should produce 2 artifact\(s\)/);
  });

  it("un slideshow de un slide sí pasa por render", async () => {
    const result = await makeRenderer(fakeService().fetch).render(SLIDESHOW_ONE, AUTH);

    expect(result.contentType).toBe("image/jpeg");
    expect(result.width).toBe(1080);
    expect(result.height).toBe(1350);
  });
});

/* ------------------------------------------------------------------------ *
 * Traducción de errores — PRD §10, `NFR-022`
 * ------------------------------------------------------------------------ */

/**
 * La tabla completa, con la clasificación de reintento.
 *
 * `retryable` no es decorativo: `apps/worker` reintenta exactamente
 * `provider_unavailable`, `timeout` y `rate_limited`, y con el resto cierra la
 * pieza y **devuelve el content save**. Un error permanente marcado como
 * reintentable retrasa un reembolso; uno transitorio marcado como permanente
 * mata una pieza que se podía construir.
 */
const TRADUCCIONES: readonly {
  readonly service: string;
  readonly status: number;
  readonly port: string;
  readonly retryable: boolean;
}[] = [
  { service: "bad_request", status: 400, port: "bad_request", retryable: false },
  {
    service: "media_url_not_allowed",
    status: 400,
    port: "bad_request",
    retryable: false,
  },
  { service: "media_grant_invalid", status: 400, port: "bad_request", retryable: false },
  {
    service: "content_unavailable_for_type",
    status: 422,
    port: "bad_request",
    retryable: false,
  },
  {
    service: "unsupported_media_format",
    status: 422,
    port: "bad_request",
    retryable: false,
  },
  { service: "media_probe_failed", status: 502, port: "not_found", retryable: false },
  { service: "font_unavailable", status: 500, port: "bad_request", retryable: false },
  {
    service: "ffmpeg_unavailable",
    status: 500,
    port: "provider_unavailable",
    retryable: true,
  },
  {
    service: "render_capability_missing",
    status: 500,
    port: "provider_unavailable",
    retryable: true,
  },
  {
    service: "render_failed",
    status: 500,
    port: "provider_unavailable",
    retryable: true,
  },
  {
    service: "render_empty_output",
    status: 500,
    port: "provider_contract_violation",
    retryable: false,
  },
  { service: "render_timeout", status: 504, port: "timeout", retryable: true },
];

describe("HttpMediaRenderer — ningún error crudo sale hacia afuera", () => {
  for (const caso of TRADUCCIONES) {
    it(`${caso.service} (${String(caso.status)}) → ${caso.port}${caso.retryable ? " reintentable" : " permanente"}`, async () => {
      const service = recorder(() =>
        json(caso.status, {
          error: {
            code: caso.service,
            message: "ffmpeg escribió 200 líneas de stderr acá",
            details: { path: "/tmp/fastgram-render-xyz/base.mp4" },
          },
        }),
      );

      const error = await thrownBy(() =>
        makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH),
      );

      expect(isPortError(error)).toBe(true);
      if (!isPortError(error)) return;
      expect(error.code).toBe(caso.port);
      expect(error.isRetryable).toBe(caso.retryable);
      expect(error.source).toBe("MediaRenderer/http");
      // El mensaje que puede cruzar hacia el cliente es neutral: ni stderr ni
      // rutas locales. El original queda en `cause`, que sólo va al log.
      expect(error.toPublic().message).not.toMatch(/stderr|tmp|ffmpeg/);
      expect(String(error.cause)).toMatch(/stderr/);
    });
  }

  it("un código que el servicio agregue después cae en la traducción por status", async () => {
    // Forward compatibility: agregar un `RenderErrorCode` allá no puede
    // producir un `PortError` con un código inventado acá.
    const service = recorder(() =>
      json(503, { error: { code: "codigo_del_futuro", message: "?", details: {} } }),
    );

    const error = await thrownBy(() =>
      makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH),
    );

    expect(error).toMatchObject({ code: "provider_unavailable" });
  });

  it("429 con retry-after preserva los segundos que el servicio pidió", async () => {
    const service = recorder(
      () => new Response("{}", { status: 429, headers: { "retry-after": "12" } }),
    );

    const error = await thrownBy(() =>
      makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH),
    );

    expect(error).toMatchObject({ code: "rate_limited", retryAfterSeconds: 12 });
  });

  it("un 404 en POST /render es la ruta que no existe: permanente y con mensaje útil", async () => {
    // Fastify contesta su propio 404 sin el envoltorio `{error:{code}}`: base
    // URL apuntando a otro servicio, o un despliegue viejo sin `/render`.
    const service = recorder(() =>
      json(404, {
        statusCode: 404,
        error: "Not Found",
        message: "Route POST:/render not found",
      }),
    );

    const error = await thrownBy(() =>
      makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH),
    );

    expect(error).toMatchObject({ code: "provider_contract_violation" });
    expect(String(error)).toMatch(/does not expose this route/);
  });

  it("artifact_not_found (404) es not_found PERMANENTE, no reintentable", async () => {
    // La clasificación que más se discutió. El razonamiento obvio —el artefacto
    // existió, re-renderizar lo vuelve a crear— lleva a marcarlo reintentable,
    // y está mal: la cache de `services/render` es **local al proceso**, así
    // que con varias réplicas el reintento es una moneda al aire, y cada
    // reintento es un encode completo (el driver de costo #2 de IMPL §5).
    // Cerrar la pieza y devolver el save le sirve más al usuario que tres
    // encodes que probablemente terminen igual.
    const service = fakeService({
      artifact: () =>
        json(404, {
          // `details: {}` viene siempre: es el `toWire()` del servicio.
          error: {
            code: "artifact_not_found",
            message: "no está en la cache",
            details: {},
          },
        }),
    });

    const error = await thrownBy(() =>
      makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH),
    );

    expect(error).toMatchObject({ name: "PortError", code: "not_found" });
    expect(isPortError(error) && error.isRetryable).toBe(false);
    // Y el mensaje distingue este `not_found` del otro —una URL del payload que
    // no se pudo leer—, que en el log es lo único que los separa.
    expect(String(error)).toMatch(/artifact is not available/);
  });

  it("un 404 de artefacto sin el código en el cuerpo llega al mismo not_found", async () => {
    const service = fakeService({ artifact: () => new Response("", { status: 404 }) });

    const error = await thrownBy(() =>
      makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH),
    );

    expect(error).toMatchObject({ code: "not_found" });
    expect(isPortError(error) && error.isRetryable).toBe(false);
  });

  it("el servicio inalcanzable es provider_unavailable, no un error crudo", async () => {
    const service = recorder(() => {
      throw new TypeError("fetch failed: ECONNREFUSED");
    });

    const error = await thrownBy(() =>
      makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH),
    );

    expect(error).toMatchObject({ name: "PortError", code: "provider_unavailable" });
  });

  it("un 200 con JSON roto es provider_contract_violation", async () => {
    const service = recorder(
      () =>
        new Response("{esto no es json", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );

    const error = await thrownBy(() =>
      makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH),
    );

    expect(error).toMatchObject({ code: "provider_contract_violation" });
  });

  it("un artefacto sin href dice que este despliegue no sirve bytes todavía", async () => {
    // El estado real de `services/render` cuando se escribió esto: devuelve
    // `{kind,index,bytes}` y nada más. El mensaje tiene que decirlo, o alguien
    // pierde una tarde mirando el mapeo del payload.
    const service = fakeService({
      artifacts: [{ kind: "video", index: 0, bytes: 10 }],
    });

    const error = await thrownBy(() =>
      makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH),
    );

    expect(error).toMatchObject({ code: "provider_contract_violation" });
    expect(String(error)).toMatch(/does not serve artifact bytes yet/);
  });

  it("un artefacto de 0 bytes no se deja pasar", async () => {
    const service = fakeService({
      artifacts: [{ kind: "video", index: 0, bytes: 0, href: HREF }],
    });

    const error = await thrownBy(() =>
      makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH),
    );

    expect(error).toMatchObject({ code: "provider_contract_violation" });
  });

  it("si el servicio dice haber construido otro formato, el mapeo divergió", async () => {
    // Trampa 19 del otro lado del cable: dos procesos y dos nombres. Si
    // `format` y `type` se separan, esto lo dice antes de subir la pieza.
    const service = fakeService({ type: "green-screen" });

    const error = await thrownBy(() =>
      makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH),
    );

    expect(error).toMatchObject({ code: "provider_contract_violation" });
    expect(String(error)).toMatch(/asked for a wall-of-text build/);
  });

  it("un href absoluto no se sigue", async () => {
    const service = fakeService({
      artifacts: [
        { kind: "video", index: 0, bytes: 10, href: "https://otro-host/artifact/x" },
      ],
    });

    const error = await thrownBy(() =>
      makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH),
    );

    expect(error).toMatchObject({ code: "provider_contract_violation" });
    expect(service.calls).toHaveLength(1);
  });
});

/* ------------------------------------------------------------------------ *
 * Content type del artefacto
 * ------------------------------------------------------------------------ */

describe("HttpMediaRenderer — qué content type se le declara a Storage", () => {
  it("un 200 con text/html es una página de error de algún proxy, no un video", async () => {
    // Subirla al bucket como si fuera el mp4 produce una pieza roto sin ningún
    // error: la única defensa es mirar el content type.
    const service = fakeService({
      artifact: () =>
        new Response("<html>502 Bad Gateway</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
    });

    const error = await thrownBy(() =>
      makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH),
    );

    expect(error).toMatchObject({ code: "provider_contract_violation" });
  });

  it("application/octet-stream cae al respaldo por kind", async () => {
    const service = fakeService({
      artifact: () => artifactResponse(BODY, "application/octet-stream"),
    });

    const result = await makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH);

    expect(result.contentType).toBe("video/mp4");
  });

  it("sin content-type también cae al respaldo", async () => {
    const service = fakeService({ artifact: () => artifactResponse(BODY, null) });

    const result = await makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH);

    expect(result.contentType).toBe("video/mp4");
  });

  it("un video que vuelve como imagen es una violación de contrato", async () => {
    const service = fakeService({ artifact: () => artifactResponse(BODY, "image/jpeg") });

    const error = await thrownBy(() =>
      makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH),
    );

    expect(error).toMatchObject({ code: "provider_contract_violation" });
  });

  it("un content-length que no coincide con lo declarado se detecta antes de bajar", async () => {
    const service = fakeService({
      artifact: () => artifactResponse(BODY, "video/mp4", 999),
    });

    const error = await thrownBy(() =>
      makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH),
    );

    expect(error).toMatchObject({ code: "provider_contract_violation" });
    expect(String(error)).toMatch(/announces 999/);
  });
});

/* ------------------------------------------------------------------------ *
 * Timeouts — `NFR-001`
 * ------------------------------------------------------------------------ */

describe("HttpMediaRenderer — un fetch sin timeout cuelga un slot del worker", () => {
  it("el POST que no contesta vence en timeout, no en un error genérico", async () => {
    // Un servicio que acepta la conexión y nunca contesta: la única salida es
    // el `AbortController`, y lo que llega al llamador tiene que ser `timeout`
    // —reintentable— y no un `Error` de aborto crudo, que `build-handler`
    // trataría como bug nuestro.
    const renderer = new HttpMediaRenderer({
      baseUrl: "http://render.internal:3002",
      engineVersion: "v1",
      timeoutMs: 25,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    });

    const error = await thrownBy(() => renderer.render(WALL_OF_TEXT, AUTH));

    expect(error).toMatchObject({ name: "PortError", code: "timeout" });
    expect(isPortError(error) && error.isRetryable).toBe(true);
  });

  it("un stream que se queda quieto vence por inactividad, no por el reloj del build", async () => {
    // El caso que ningún timeout de `fetch` cubre: las cabeceras llegaron, el
    // cuerpo no avanza. Sin el reloj de inactividad, el `for await` no termina
    // nunca y el job se queda con el slot para siempre.
    const stalled = new ReadableStream<Uint8Array>({
      start() {
        /* no encola nada y no cierra */
      },
    });
    const service = fakeService({
      artifact: () =>
        new Response(stalled, {
          status: 200,
          headers: { "content-type": "video/mp4" },
        }),
    });

    const renderer = makeRenderer(service.fetch, { idleTimeoutMs: 25 });
    const result = await renderer.render(WALL_OF_TEXT, AUTH);
    const error = await thrownBy(() => drain(result.body));

    expect(error).toMatchObject({ name: "PortError", code: "timeout" });
  });

  it("un artefacto truncado falla en vez de subirse como completo", async () => {
    // El servicio declara 30 bytes y manda 5. Sin el conteo, esos 5 bytes se
    // suben al bucket y la pieza queda publicada y roto.
    const service = fakeService({
      artifacts: [{ kind: "video", index: 0, bytes: 30, href: HREF }],
      artifact: () =>
        artifactResponse(new TextEncoder().encode("corto"), "video/mp4", 30),
    });

    const result = await makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH);
    const error = await thrownBy(() => drain(result.body));

    expect(error).toMatchObject({ code: "provider_contract_violation" });
    expect(String(error)).toMatch(/declared 30 bytes and delivered 5/);
  });
});

/* ------------------------------------------------------------------------ *
 * fingerprint
 * ------------------------------------------------------------------------ */

describe("HttpMediaRenderer — fingerprint", () => {
  it("es puro: no toca la red (trampa 23)", async () => {
    // La aserción que la suite de contrato no puede hacer. Su caso «fingerprint
    // es puro» comparaba dos llamadas sobre la misma instancia, y un renderer
    // con un `randomUUID()` por instancia la pasaba entera. Acá se verifica lo
    // que «puro» quiere decir de verdad: **cero llamadas al servicio**.
    const service = recorder(() => {
      throw new Error("fingerprint llamó al servicio");
    });
    const renderer = makeRenderer(service.fetch);

    for (const job of ALL_JOBS) renderer.fingerprint(job);

    expect(service.calls).toHaveLength(0);
    await Promise.resolve();
  });

  it("es igual entre dos instancias del mismo motor", () => {
    // La garantía que el cache de IMPL §5 necesita es **entre procesos**: cada
    // worker construye su propio renderer y tiene que llegar al mismo hash.
    const uno = makeRenderer(fakeService().fetch);
    const otro = makeRenderer(fakeService().fetch);

    expect(otro.fingerprint(WALL_OF_TEXT)).toBe(uno.fingerprint(WALL_OF_TEXT));
  });

  it("no depende del orden de las claves del job", () => {
    // `core` arma los payloads con spreads: dos spreads en distinto orden dan
    // el mismo objeto con distinto `JSON.stringify`.
    const renderer = makeRenderer(fakeService().fetch);
    const reordenado: WallOfTextJob = {
      text: WALL_OF_TEXT.text,
      audio: WALL_OF_TEXT.audio,
      video: WALL_OF_TEXT.video,
      canvas: WALL_OF_TEXT.canvas,
      format: "wall-of-text",
    };

    expect(renderer.fingerprint(reordenado)).toBe(renderer.fingerprint(WALL_OF_TEXT));
  });

  it("un upgrade del motor lo invalida (P2-RENDER-011)", () => {
    const v0 = new HttpMediaRenderer({
      baseUrl: "http://r:3002",
      engineVersion: "ffmpeg-7.0",
      fetch: fakeService().fetch,
    });
    const v1 = new HttpMediaRenderer({
      baseUrl: "http://r:3002",
      engineVersion: "ffmpeg-7.1",
      fetch: fakeService().fetch,
    });

    expect(v1.fingerprint(WALL_OF_TEXT)).not.toBe(v0.fingerprint(WALL_OF_TEXT));
  });

  it("distingue los cuatro formatos y un cambio de texto", () => {
    const renderer = makeRenderer(fakeService().fetch);
    const hashes = new Set(ALL_JOBS.map((job) => renderer.fingerprint(job)));

    expect(hashes.size).toBe(ALL_JOBS.length);

    const otroTexto: RenderText = { ...TEXT, content: "hook B" };
    expect(renderer.fingerprint({ ...WALL_OF_TEXT, text: otroTexto })).not.toBe(
      renderer.fingerprint(WALL_OF_TEXT),
    );
  });

  it("no depende del base URL: dos despliegues del mismo motor comparten cache", () => {
    const a = new HttpMediaRenderer({
      baseUrl: "http://render-a:3002",
      engineVersion: "v1",
      fetch: fakeService().fetch,
    });
    const b = new HttpMediaRenderer({
      baseUrl: "http://render-b:3002",
      engineVersion: "v1",
      fetch: fakeService().fetch,
    });

    expect(a.fingerprint(GREEN_SCREEN)).toBe(b.fingerprint(GREEN_SCREEN));
  });

  it("el hash de un job conocido está fijado (golden)", () => {
    // Lo que este caso protege no es el valor: es que **nadie cambie la entrada
    // canónica sin querer**. Agregar un campo al objeto que se hashea, o
    // reordenarlo, invalida de golpe todas las entradas de cache que haya en
    // producción. Eso no rompe nada visible —los renders salen bien— y sólo se
    // nota en la factura de CPU, que es el driver de costo #2 de IMPL §5.
    //
    // Si este caso se pone rojo hay exactamente dos respuestas válidas: o el
    // cambio era involuntario y se revierte, o era a propósito y entonces hay
    // que subir `MAPPING_VERSION` y actualizar este golden en el mismo commit.
    const renderer = new HttpMediaRenderer({
      baseUrl: "http://r:3002",
      engineVersion: "golden-0",
      fetch: fakeService().fetch,
    });

    expect(renderer.fingerprint(WALL_OF_TEXT)).toBe(
      "efb59baa7bc31b86f32e521be949dec0a5a379307ad8cf7b0a431de58d4b6737",
    );
  });
});

/* ------------------------------------------------------------------------ *
 * Validación local y configuración
 * ------------------------------------------------------------------------ */

describe("HttpMediaRenderer — lo que se rechaza sin gastar una petición", () => {
  it("num_images que no coincide es bad_request y no llega al servicio", async () => {
    const service = fakeService();
    const roto: SlideshowJob = { ...SLIDESHOW, num_images: 3 };

    const error = await thrownBy(() => makeRenderer(service.fetch).render(roto, AUTH));

    expect(error).toMatchObject({ name: "PortError", code: "bad_request" });
    expect(service.calls).toHaveLength(0);
  });

  it("un fontSize fuera de [8, 72] es bad_request, igual que en el de memoria", async () => {
    const service = fakeService();
    const roto: WallOfTextJob = { ...WALL_OF_TEXT, text: { ...TEXT, fontSize: 120 } };

    const error = await thrownBy(() => makeRenderer(service.fetch).render(roto, AUTH));

    expect(error).toMatchObject({ code: "bad_request" });
    expect(service.calls).toHaveLength(0);
  });

  it("sin base URL o sin versión de motor no se construye", () => {
    expect(
      () => new HttpMediaRenderer({ baseUrl: "", engineVersion: "v1" }),
    ).toThrowError(/base URL/);
    // Un default silencioso de versión haría que un upgrade de FFmpeg no
    // invalide el cache, y nadie lo notaría hasta ver la tipografía movida.
    expect(
      () => new HttpMediaRenderer({ baseUrl: "http://r:3002", engineVersion: "" }),
    ).toThrowError(/engine version/);
  });

  it("normaliza la barra final del base URL", async () => {
    const service = fakeService();
    const renderer = new HttpMediaRenderer({
      baseUrl: "http://render.internal:3002///",
      engineVersion: "v1",
      fetch: service.fetch,
    });

    await renderer.render(WALL_OF_TEXT, AUTH);

    expect(service.calls[0]?.url).toBe("http://render.internal:3002/render");
  });
});

describe("HttpMediaRenderer — probe, normalize y thumbnail", () => {
  // `P2-RENDER-016` agregó los tres endpoints del lado del servicio y el
  // adaptador se quedó tirando `provider_unavailable` («falta POST /probe»)
  // para los tres. O sea: existían y no se llamaban. Es el punto de
  // integración que no verifica ninguno de los dos lados.

  it("probe devuelve las banderas que gobiernan la normalización", async () => {
    const service = fakeService();
    const probe = await makeRenderer(service.fetch).probe(
      "https://media.test/x.mov",
      AUTH,
    );

    expect(probe).toMatchObject({
      contentType: "video/quicktime",
      width: 1080,
      height: 1920,
      isHdr: false,
      isFastStart: false,
      hasAudio: true,
    });
    expect(service.calls[0]?.url).toBe("http://render.internal:3002/probe");
  });

  it("probe rechaza una respuesta sin `isHdr` en vez de asumir que no lo es", async () => {
    // **Es el caso que más caro sale de este archivo.** Un default `false`
    // hace que `NFR-014` no tone-mapee un PQ real: la pieza sale lavada, se
    // publica, y no hay un solo error en ningún log. Un incumplimiento de
    // contrato ruidoso es infinitamente mejor que un color equivocado callado.
    const { isHdr: _omitida, ...sinBandera } = PROBE_OK;
    const error = await thrownBy(() =>
      makeRenderer(fakeService({ probe: sinBandera }).fetch).probe(
        "https://media.test/x.mov",
        AUTH,
      ),
    );

    expect(error).toMatchObject({ code: "provider_contract_violation" });
  });

  it("normalize manda el content type pedido y baja los bytes por el href", async () => {
    const service = fakeService();
    const media = await makeRenderer(service.fetch).normalize(
      { url: "https://media.test/x.mov", targetContentType: "video/mp4" },
      AUTH,
    );

    const pedido = JSON.parse(service.calls[0]?.body ?? "{}") as {
      targetContentType?: string;
    };
    expect(pedido.targetContentType).toBe("video/mp4");
    // Los bytes NO vienen en la respuesta JSON: viene el href, y hay que ir a
    // buscarlos. Si el adaptador se quedara con el metadato, esto daría 0.
    expect(await drain(media.body)).toBe(BODY.byteLength);
    expect(service.calls[1]?.url).toContain("/artifact/");
  });

  it("thumbnail reporta lo que MIDIÓ el servicio, no el maxWidth pedido", async () => {
    // Un thumbnail con `maxWidth: 320` sobre un 9:16 no mide 320 de ancho.
    // Devolver el pedido en vez de lo medido haría que la comprobación de
    // «nunca servir el master» de IMPL §5 pase siempre, midiendo el pedido
    // contra sí mismo.
    const service = fakeService({
      described: { ...DESCRIBED_OK, contentType: "image/jpeg", width: 180, height: 320 },
    });
    const thumb = await makeRenderer(service.fetch).thumbnail(
      { url: "https://media.test/x.mov", maxWidth: 320, atSeconds: 2 },
      AUTH,
    );

    expect(thumb.width).toBe(180);
    expect(thumb.height).toBe(320);
    expect(thumb.contentType).toBe("image/jpeg");
  });

  it("thumbnail omite `atSeconds` cuando no se pidió", async () => {
    const service = fakeService();
    await makeRenderer(service.fetch).thumbnail(
      { url: "https://media.test/x.mov", maxWidth: 320 },
      AUTH,
    );

    // El schema del servicio es `.strict()`: mandar `atSeconds: undefined`
    // serializa la clave y el pedido se rechaza con 400.
    expect(service.calls[0]?.body ?? "").not.toContain("atSeconds");
  });
});

describe("HttpMediaRenderer — el grant firmado (NFR-006)", () => {
  const RELOJ: Clock = new FixedClock(new Date(1_700_000_000_000));
  // No es un secreto de verdad: es una cadena de prueba. El secreto real vive
  // en el entorno y nunca en el repo.
  const SECRETO = "secreto-de-prueba";

  it("sin secreto configurado no manda grant", async () => {
    // Es una topología válida —un entorno con un solo bucket y prefijos
    // globales—, así que no puede fallar. Lo que no puede es mandar un grant
    // sin firma, que el servicio rechazaría con `media_grant_invalid`.
    const service = fakeService();
    await makeRenderer(service.fetch).render(WALL_OF_TEXT, AUTH);

    expect(service.calls[0]?.body ?? "").not.toContain("grant");
  });

  it("con secreto manda el companyId y los prefijos de la autorización", async () => {
    const service = fakeService();
    await makeRenderer(service.fetch, {
      grantSecret: SECRETO,
      clock: RELOJ,
    }).render(WALL_OF_TEXT, AUTH);

    const enviado = JSON.parse(service.calls[0]?.body ?? "{}") as {
      grant?: { body?: Record<string, unknown>; signature?: string };
    };
    expect(enviado.grant?.body).toMatchObject({
      companyId: "com_prueba",
      mediaPrefixes: ["https://media.test/"],
      sharedPrefixes: ["https://library.test/"],
      issuedAt: 1_700_000_000_000,
    });
    expect(enviado.grant?.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("el grant se acuña por pedido, no por instancia", async () => {
    // Un worker vive días. Un grant acuñado al construir el adaptador mandaría
    // `expiresAt` vencidos para siempre después de la primera hora, y el
    // síntoma sería `media_grant_invalid` en **todos** los builds.
    let ahora = 1_700_000_000_000;
    const service = fakeService();
    const renderer = makeRenderer(service.fetch, {
      grantSecret: SECRETO,
      clock: { nowMs: () => ahora, now: () => new Date(ahora) },
    });

    await renderer.render(WALL_OF_TEXT, AUTH);
    ahora += 3_600_000;
    await renderer.render(WALL_OF_TEXT, AUTH);

    const emitidos = service.calls
      .filter((call) => call.url.endsWith("/render"))
      .map((call) => {
        const cuerpo = JSON.parse(call.body ?? "{}") as {
          grant?: { body?: { issuedAt?: number } };
        };
        return cuerpo.grant?.body?.issuedAt;
      });
    expect(emitidos).toEqual([1_700_000_000_000, 1_700_003_600_000]);
  });

  it("dos workspaces con la misma media producen firmas distintas", async () => {
    // Es la propiedad que sostiene `NFR-006`. Si el `companyId` no entrara a la
    // firma, un grant del workspace 42 serviría para el 43 y el aislamiento
    // sería decorativo.
    const firmar = async (companyId: string): Promise<string> => {
      const service = fakeService();
      await makeRenderer(service.fetch, { grantSecret: SECRETO, clock: RELOJ }).render(
        WALL_OF_TEXT,
        { ...AUTH, companyId },
      );
      const cuerpo = JSON.parse(service.calls[0]?.body ?? "{}") as {
        grant?: { signature?: string };
      };
      return cuerpo.grant?.signature ?? "";
    };

    expect(await firmar("com_42")).not.toBe(await firmar("com_43"));
  });

  it("las tres operaciones de media también lo llevan", async () => {
    // Sin esto, `probe` sobre una URL ajena pasaría el filtro de prefijos
    // globales: son los mismos para todos los workspaces.
    const service = fakeService();
    const renderer = makeRenderer(service.fetch, { grantSecret: SECRETO, clock: RELOJ });

    await renderer.probe("https://media.test/x.mov", AUTH);
    await renderer.normalize(
      { url: "https://media.test/x.mov", targetContentType: "video/mp4" },
      AUTH,
    );
    await renderer.thumbnail({ url: "https://media.test/x.mov", maxWidth: 320 }, AUTH);

    const conGrant = service.calls
      .filter((call) => call.method === "POST")
      .map((call) => (call.body ?? "").includes('"grant"'));
    expect(conGrant).toEqual([true, true, true]);
  });
});

describe("fetchRenderEngineVersion — la parte que sí puede tocar la red", () => {
  it("arma la etiqueta con la versión de ffmpeg y la estrategia de texto", async () => {
    const service = recorder(() =>
      json(200, {
        ffmpeg: { available: true, version: "7.1.1", hasDrawtext: false },
        textStrategy: "sharp-overlay",
      }),
    );

    const version = await fetchRenderEngineVersion({
      baseUrl: "http://render.internal:3002",
      fetch: service.fetch,
    });

    expect(version).toBe("ffmpeg-7.1.1+text-sharp-overlay");
    expect(service.calls[0]?.url).toBe("http://render.internal:3002/capabilities");
  });

  it("un servicio sin ffmpeg no da versión: mejor no levantar el worker", async () => {
    const service = recorder(() =>
      json(200, { ffmpeg: { available: false, version: null }, textStrategy: "x" }),
    );

    const error = await thrownBy(() =>
      fetchRenderEngineVersion({ baseUrl: "http://r:3002", fetch: service.fetch }),
    );

    expect(error).toMatchObject({ name: "PortError", code: "provider_unavailable" });
  });
});

/* ------------------------------------------------------------------------ *
 * La suite de contrato del puerto, contra `services/render` de verdad
 * ------------------------------------------------------------------------ */

const BASE_URL = process.env["RENDER_BASE_URL"] ?? "http://localhost:3002";
const IMAGE_URL = process.env["RENDER_TEST_IMAGE_URL"];
const VIDEO_URL = process.env["RENDER_TEST_VIDEO_URL"];
const AUDIO_URL = process.env["RENDER_TEST_AUDIO_URL"];

async function probeHealth(): Promise<string | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, 2_000);
  try {
    const response = await fetch(`${BASE_URL}/health`, { signal: controller.signal });
    await response.text().catch(() => "");
    return response.ok ? null : `/health respondió ${String(response.status)}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
}

const down = await probeHealth();
const faltaMedia =
  IMAGE_URL === undefined || VIDEO_URL === undefined || AUDIO_URL === undefined;

let engineVersion = "sin-servicio";
let sinMotor: string | null = null;
if (down === null) {
  try {
    engineVersion = await fetchRenderEngineVersion({ baseUrl: BASE_URL });
  } catch (error) {
    sinMotor = error instanceof Error ? error.message : String(error);
  }
}

const reason =
  down !== null
    ? `SALTEADA — services/render no responde en ${BASE_URL}: ${down}`
    : sinMotor !== null
      ? `SALTEADA — ${BASE_URL} no reporta un ffmpeg usable: ${sinMotor}`
      : faltaMedia
        ? "SALTEADA — faltan RENDER_TEST_IMAGE_URL / RENDER_TEST_VIDEO_URL / " +
          "RENDER_TEST_AUDIO_URL: sin media alcanzable un renderer no se puede verificar"
        : null;

/**
 * El motivo del salteo va **en el nombre de cada caso**, no sólo en el del
 * bloque.
 *
 * Y además por `console.warn`, que es lo único que el reporter por defecto de
 * vitest imprime sí o sí. Verificado: con el servicio apagado, `pnpm test`
 * muestra «10 skipped» y **nada más** —ni el nombre del bloque, ni el de los
 * casos—, porque el reporter esconde los salteados. Una suite que se saltea en
 * silencio es cobertura que nadie corre, y el aviso es la diferencia entre
 * «acá no se verificó el motor real» y diez casos verdes que nadie mira.
 */
if (reason !== null) {
  console.warn(`\n⚠︎  MediaRenderer contract · http: ${reason}\n`);
}

const harness = {
  describe,
  it:
    reason === null
      ? it
      : (name: string, body: () => void | Promise<void>) => {
          it.skip(`${name} · ${reason}`, body);
        },
};

/**
 * `videoToNormalize` va sin definir **a propósito**, y el nombre de la suite lo
 * dice: los tres casos que dependen de él (`probe`, `normalize`, `thumbnail`)
 * sólo se pueden correr contra endpoints que `services/render` no expone. Los
 * casos existen y afirman el `PortError` en el bloque de arriba.
 */
const liveJobs: readonly RenderJob[] =
  IMAGE_URL === undefined || VIDEO_URL === undefined || AUDIO_URL === undefined
    ? []
    : [
        {
          format: "slideshow",
          num_images: 1,
          images: [
            {
              canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
              image: {
                url: IMAGE_URL,
                drawX: 0,
                drawY: 0,
                drawW: 1080,
                drawH: 1350,
              },
              texts: [TEXT],
            },
          ],
        },
        {
          ...WALL_OF_TEXT,
          video: { ...WALL_OF_TEXT.video, url: VIDEO_URL },
          audio: { url: AUDIO_URL },
        },
        {
          ...GREEN_SCREEN,
          image: { ...GREEN_SCREEN.image, url: IMAGE_URL },
          video: { ...GREEN_SCREEN.video, url: VIDEO_URL },
        },
        {
          ...VIDEO_HOOK,
          hook_video: { ...VIDEO_HOOK.hook_video, url: VIDEO_URL },
          demo_video: { ...VIDEO_HOOK.demo_video, url: VIDEO_URL },
          audio: { url: AUDIO_URL },
        },
      ];

describeMediaRendererContract(
  harness,
  reason === null
    ? "http · services/render · normalize/probe/thumbnail sin endpoint del otro lado"
    : `http · ${reason}`,
  {
    makeAdapter: () => new HttpMediaRenderer({ baseUrl: BASE_URL, engineVersion }),
    // Con el servicio caído la lista está vacía y los casos van a `it.skip`
    // igual; el `sampleJobs` vacío no puede hacer pasar nada por accidente
    // porque el primer caso de la suite afirma que no esté vacía.
    sampleJobs: liveJobs,
    auth: AUTH,
  },
);
