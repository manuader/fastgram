/**
 * El contrato contra la realidad: **los paths del OpenAPI son los que Fastify
 * registra**, en los dos sentidos.
 *
 * ## Por qué existe
 *
 * `packages/contracts/src/openapi.ts` publicaba cinco paths `/brand/*` que
 * **no existían**: `apps/api` no tenía una sola ruta `/brand`. Duró porque el
 * test del documento (`openapi.test.ts`) recorre una lista de 27 paths escrita a
 * mano y comprueba que estén — o sea, fija un número y no compara con nada. Un
 * path de más no lo ve nadie, y un path de menos tampoco: ninguna de las dos
 * mitades del contrato estaba verificada.
 *
 * Este archivo cierra las dos:
 *
 *  1. **Documentado ⇒ registrado.** Un `operationId` en el documento que no
 *     corresponde a ninguna ruta es una promesa que el SDK generado ofrece y
 *     que devuelve 404.
 *  2. **Registrado ⇒ documentado.** Una ruta viva que el documento no nombra es
 *     superficie pública que nadie revisó: no está en el SDK, no tiene schema
 *     publicado, y se entera de ella quien la encuentre.
 *
 * ## Por qué es un test de unit y no de integración
 *
 * No toca la base. `createDb` de `postgres.js` es perezoso —no abre conexión
 * hasta la primera query— y **registrar** rutas no consulta nada: el `db` sólo
 * se usa dentro del hook de scope y de las sondas de `/health`, y acá no entra
 * ninguna petición. Ponerlo en la suite de integración lo dejaría fuera de
 * `pnpm test`, que es donde la deriva del contrato tiene que doler: en el
 * commit, no en el CI nocturno.
 *
 * ## Cómo se enumeran las rutas reales
 *
 * `app.printRoutes()` sobre la app **que construye `buildServer`**, no sobre un
 * montaje paralelo armado en el test. La diferencia importa: un test que
 * registrara `registerV1Routes` por su cuenta mediría su propio montaje, y una
 * ruta agregada directamente en `app.ts` —como las tres de `/health`— sería
 * invisible para él.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import { buildOpenApiDocument } from "@fastgram/contracts";
import { APP_ROLE, createDb, type DbHandle } from "@fastgram/db";

import { buildServer, API_V1_PREFIX } from "../src/server/app.js";
import { IdempotencyGuard } from "../src/http/idempotency.js";
import { TokenBucketLimiter } from "../src/http/rate-limit.js";
import { createMemoryBucketStore } from "../src/support/bucket-store.js";

/**
 * Rutas registradas a propósito **fuera** de la v1, y por eso fuera del
 * documento: son para el orquestador, no para integradores, y `app.ts` dice que
 * no deben cambiar cuando salga una v2. Es una lista corta y explícita: si
 * mañana aparece otra ruta sin versionar, el test la va a señalar, que es lo
 * que se quiere.
 */
const OUTSIDE_V1 = new Set(["/health", "/health/live", "/health/ready"]);

/** Fastify añade `HEAD` a cada `GET` y `OPTIONS` con CORS; no son superficie. */
const IMPLICIT_METHODS = new Set(["HEAD", "OPTIONS"]);

interface RegisteredRoute {
  readonly method: string;
  /** Ya normalizado al vocabulario del OpenAPI: `/brand/sources/{id}`. */
  readonly path: string;
}

/**
 * Parsea el árbol de `printRoutes` a `(método, path)`.
 *
 * El árbol es de prefijos: cada nivel imprime **sólo su segmento**, así que el
 * path completo es la concatenación de los ancestros. Cada nivel de sangría son
 * cuatro caracteres (`│   ` o cuatro espacios), que es lo que da la profundidad.
 */
export function parsePrintedRoutes(tree: string): RegisteredRoute[] {
  const out: RegisteredRoute[] = [];
  const stack: string[] = [];

  for (const raw of tree.split("\n")) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;

    const marker = Math.max(line.indexOf("├── "), line.indexOf("└── "));
    const depth = marker === -1 ? 0 : marker / 4;
    const rest = marker === -1 ? line : line.slice(marker + 4);

    const paren = rest.lastIndexOf(" (");
    const segment = paren === -1 ? rest : rest.slice(0, paren);
    const methods =
      paren === -1
        ? []
        : rest
            .slice(paren + 2, -1)
            .split(", ")
            .map((m) => m.trim())
            .filter((m) => m.length > 0);

    stack.length = depth;
    stack.push(segment);
    const full = stack.join("");

    for (const method of methods) {
      if (IMPLICIT_METHODS.has(method)) continue;
      out.push({ method, path: normalize(full) });
    }
  }
  return out;
}

/** `/api/v1/brand/sources/:id` → `/brand/sources/{id}`. */
function normalize(full: string): string {
  const withoutPrefix = full.startsWith(API_V1_PREFIX)
    ? full.slice(API_V1_PREFIX.length)
    : full;
  return withoutPrefix.replace(/:([A-Za-z0-9_]+)/g, "{$1}");
}

const key = (method: string, path: string): string => `${method.toUpperCase()} ${path}`;

let handle: DbHandle;
let app: FastifyInstance;

beforeAll(async () => {
  // Nunca se conecta: `postgres.js` abre el socket en la primera query y acá no
  // hay ninguna. La URL es sintáctica, no alcanzable.
  handle = createDb({ url: "postgres://unused:unused@127.0.0.1:1/unused", max: 1 });
  const clock = new FixedClock("2026-09-22T00:00:00.000Z");

  app = await buildServer({
    deps: {
      db: handle.db,
      clock,
      storage: new MemoryStorage(clock),
      limiter: new TokenBucketLimiter(createMemoryBucketStore(), clock),
      // Nunca se usa: no entra ninguna petición. El store lanza en vez de
      // devolver algo plausible, para que el día que este archivo empiece a
      // inyectar peticiones se entere en vez de medir un doble silencioso.
      idempotency: new IdempotencyGuard(
        {
          claim: () => {
            throw new Error("este test no ejecuta rutas");
          },
          complete: () => {
            throw new Error("este test no ejecuta rutas");
          },
          release: () => {
            throw new Error("este test no ejecuta rutas");
          },
        },
        clock,
      ),
      appRole: APP_ROLE,
    },
    logLevel: "silent",
    enableAccessLog: false,
  });
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await handle?.close();
});

describe("el OpenAPI describe exactamente la superficie registrada", () => {
  const documented = (): Set<string> => {
    const doc = buildOpenApiDocument();
    const out = new Set<string>();
    for (const [path, operations] of Object.entries(doc.paths)) {
      for (const method of Object.keys(operations)) out.add(key(method, path));
    }
    return out;
  };

  const registered = (): Set<string> => {
    const routes = parsePrintedRoutes(app.printRoutes({ commonPrefix: false }));
    const out = new Set<string>();
    for (const route of routes) {
      if (OUTSIDE_V1.has(route.path)) continue;
      out.add(key(route.method, route.path));
    }
    return out;
  };

  it("ninguna operación documentada falta en Fastify", () => {
    const missing = [...documented()].filter((op) => !registered().has(op)).sort();
    // El mensaje lleva la lista entera: un `toEqual([])` a secas obliga a
    // ejecutar el test mentalmente para saber cuál falta.
    expect(missing, `documentadas pero NO registradas: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("ninguna ruta registrada falta en el OpenAPI", () => {
    const undocumented = [...registered()].filter((op) => !documented().has(op)).sort();
    expect(
      undocumented,
      `registradas pero NO documentadas: ${undocumented.join(", ")}`,
    ).toEqual([]);
  });

  it("las rutas de brand existen de verdad (EXT-001)", () => {
    // El caso concreto que motivó el archivo. Vale aparte de la comparación
    // general porque un día alguien puede "arreglar" la deriva borrando los
    // paths del documento en vez de escribiendo las rutas, y las dos pruebas de
    // arriba se pondrían verdes con eso.
    for (const [method, path] of [
      ["POST", "/api/v1/brand/sources/resolve"],
      ["POST", "/api/v1/brand/sources"],
      ["GET", "/api/v1/brand/sources"],
      ["GET", "/api/v1/brand/sources/:id"],
      ["PATCH", "/api/v1/brand/sources/:id"],
      ["DELETE", "/api/v1/brand/sources/:id"],
      ["POST", "/api/v1/brand/sources/:id/reanalyse"],
      ["GET", "/api/v1/brand/profile"],
      ["PATCH", "/api/v1/brand/profile"],
    ] as const) {
      expect(app.hasRoute({ method, url: path }), `falta ${method} ${path}`).toBe(true);
    }
  });
});

describe("el parser del árbol de rutas", () => {
  // El parser es la única pieza del archivo que puede mentir en silencio: si
  // devolviera la lista vacía, las dos comparaciones de arriba pasarían con
  // honores. Estos casos lo fijan contra la forma real de `printRoutes`.
  it("acumula el prefijo de los ancestros y descarta HEAD", () => {
    const tree = [
      "├── /health (GET, HEAD)",
      "├── /api/v1/brand/sources (GET, HEAD, POST)",
      "│   └── /:id (GET, HEAD)",
      "│       └── /reanalyse (POST)",
      "└── /api/v1/media (GET, HEAD)",
      "    └── /:id (DELETE)",
    ].join("\n");

    expect(parsePrintedRoutes(tree)).toEqual([
      { method: "GET", path: "/health" },
      { method: "GET", path: "/brand/sources" },
      { method: "POST", path: "/brand/sources" },
      { method: "GET", path: "/brand/sources/{id}" },
      { method: "POST", path: "/brand/sources/{id}/reanalyse" },
      { method: "GET", path: "/media" },
      { method: "DELETE", path: "/media/{id}" },
    ]);
  });

  it("no devuelve una lista vacía sobre la app real", () => {
    expect(
      parsePrintedRoutes(app.printRoutes({ commonPrefix: false })).length,
    ).toBeGreaterThan(20);
  });
});
