/**
 * `POST /content/:id/schedule` — `FR-060`, §9.5 #8, ADR-005.
 *
 * ## Por qué este archivo existe
 *
 * Porque la ruta **no tenía ningún test de integración** y estaba rota.
 *
 * Encolaba en `"publish-post"`, un literal escrito a mano en `posts.ts` cuando
 * todavía no existía el registro de colas. El registro llegó después y nombró a
 * esa cola `"publishing"`. Los dos nombres convivieron sin que nada fallara,
 * porque:
 *
 * - `main.ts` registra `[...ALL_JOB_QUEUES]`, que no contiene `"publish-post"`,
 *   y pg-boss **se niega** a encolar en una cola no registrada dentro de una
 *   transacción → la ruta devolvía **500, siempre**;
 * - el arnés de tests usaba una cola que aceptaba cualquier nombre;
 * - y nadie ejercitaba la ruta, así que ni eso importaba.
 *
 * Medido contra pg-boss de verdad antes de arreglarlo:
 *
 * ```
 * FALLO  en "publish-post" -> Queue "publish-post" must be registered before
 *                             enqueuing inside a transaction
 * ENCOLO en "publishing"
 * ```
 *
 * Cuarta aparición de la trampa 19. Las dos mitades del arreglo son el nombre
 * saliendo de `JOB_QUEUES` y el arnés validando contra `ALL_JOB_QUEUES` — pero
 * la validación del arnés **no cazaba nada** hasta que existió este archivo:
 * con el bug puesto, los 82 tests seguían verdes. Un guardián sin nadie que
 * pase por delante no guarda nada.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JOB_QUEUES } from "@fastgram/core";

import { dataOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;

/** El reloj del arnés está en 2026-09-21T12:00Z; esto es futuro para él. */
const CUANDO = new Date("2026-10-01T15:00:00.000Z").getTime();

const cuerpo = (over: Record<string, unknown> = {}) => ({
  scheduledAtUtc: CUANDO,
  targets: [
    {
      platform: "tiktok",
      connectionId: api.data.a.connectionId,
      title: "hola",
    },
  ],
  ...over,
});

const programar = (contentId: string, over: Record<string, unknown> = {}) =>
  api.request({
    method: "POST",
    path: `/api/v1/content/${contentId}/schedule`,
    body: cuerpo(over),
  });

beforeAll(async () => {
  api = await startApi();
}, 180_000);

afterAll(async () => {
  await api?.close();
});

beforeEach(() => {
  api.queue.reset();
});

describe("el camino feliz", () => {
  it("crea el post y responde 201", async () => {
    const res = await programar(api.data.a.contentId);
    expect(res.status).toBe(201);
  });

  it("encola en la cola que el worker de verdad escucha", async () => {
    // **Ésta es la aserción por la que existe el archivo.** No comprueba "que
    // encole": comprueba *dónde*. El nombre se compara contra `JOB_QUEUES` y no
    // contra un literal escrito acá, porque un literal en el test repetiría
    // exactamente el error que el test persigue — y entonces el test pasaría
    // con la ruta rota, que es lo que estuvo pasando.
    await programar(api.data.a.contentId);

    expect(api.queue.enqueued).not.toHaveLength(0);
    for (const job of api.queue.enqueued) {
      expect(job.queue).toBe(JOB_QUEUES.publishing);
    }
  });

  it("encola un job por target, con el `postId` de su fila", async () => {
    // `FR-060` hace fan-out por (contenido × plataforma × cuenta). El payload es
    // mínimo a propósito: el worker relee la fila con su propio scope, así que
    // lo único que tiene que viajar es a quién releer.
    const res = await programar(api.data.a.contentId);
    const posts = dataOf(res) as unknown as { _id: string }[];
    const creados = Array.isArray(posts) ? posts : [posts];

    expect(api.queue.enqueued).toHaveLength(creados.length);
    const encolados = api.queue.enqueued.map(
      (j) => (j.payload as { postId: string }).postId,
    );
    expect(new Set(encolados).size).toBe(creados.length);
  });

  it("el job no se publica antes de la hora programada", async () => {
    // `startAfter` es lo que hace que programar signifique algo. Sin él, el post
    // sale en el próximo poll del worker — o sea, ahora.
    await programar(api.data.a.contentId);
    const job = api.queue.enqueued[0];
    expect(job?.options?.startAfter?.getTime()).toBe(CUANDO);
  });

  it("no se reintenta automáticamente", async () => {
    // `NFR-015` prohíbe duplicar un post y `NFR-005` prohíbe reintentar lo que no
    // es idempotente: un segundo intento después de un timeout del proveedor
    // puede dejar dos posts en la cuenta del usuario, y eso no se deshace desde
    // acá. El catálogo del worker declara `maxAttempts: 1` para esta cola; esto
    // comprueba la otra mitad, la del productor.
    await programar(api.data.a.contentId);
    expect(api.queue.enqueued[0]?.options?.retryLimit).toBe(0);
  });
});

describe("aislamiento y validación", () => {
  it("el contenido de otro workspace da 404, no 403", async () => {
    // §9.2: el acceso cruzado no puede revelar existencia. Se apunta a un id que
    // **existe de verdad** del otro lado, que es el único 404 que prueba algo.
    const res = await programar(api.data.b.contentId);
    expect(res.status).toBe(404);
    expect(api.queue.enqueued).toHaveLength(0);
  });

  it("la conexión de otro workspace no sirve para programar", async () => {
    const res = await programar(api.data.a.contentId, {
      targets: [
        {
          platform: "tiktok",
          connectionId: api.data.b.connectionId,
          title: "ajena",
        },
      ],
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(api.queue.enqueued).toHaveLength(0);
  });

  it("sin targets es 400 y no encola nada", async () => {
    const res = await programar(api.data.a.contentId, { targets: [] });
    expect(res.status).toBe(400);
    expect(api.queue.enqueued).toHaveLength(0);
  });
});

describe("x, threads y facebook (D-09)", () => {
  it.each(["x", "threads", "facebook"] as const)(
    "%s: con una conexión activa única, programar crea el post de esa red",
    async (platform) => {
      const [conn] = await api.handle.sql<{ id: string }[]>`
        insert into connections (company_id, platform, platform_user_id, platform_username, scopes, publishable)
        values (${api.data.a.companyId}, ${platform}, ${`${platform}-sched`}, ${platform}, '{}', true)
        returning id
      `;
      try {
        const res = await programar(api.data.a.contentId, {
          targets: [{ platform, caption: "hola" }],
        });
        expect(res.status).toBe(201);
        const [post] = dataOf(res) as unknown as {
          platform: string;
          connectionId: string;
          caption: string;
          accountType: string;
        }[];
        expect(post).toMatchObject({
          platform,
          connectionId: conn?.id,
          caption: "hola",
          accountType: "oauth",
        });
        expect(api.queue.forQueue(JOB_QUEUES.publishing)).toHaveLength(1);
      } finally {
        // Revocada y no borrada: el post la referencia (`posts_account_exclusive`).
        await api.handle.sql`
          update connections set status = 'revoked' where id = ${conn?.id ?? ""}
        `;
      }
    },
  );

  it("x con una caption de más de 280 → 400 y no crea nada", async () => {
    const res = await programar(api.data.a.contentId, {
      targets: [{ platform: "x", caption: "c".repeat(281) }],
    });
    expect(res.status).toBe(400);
    expect(api.queue.forQueue(JOB_QUEUES.publishing)).toHaveLength(0);
  });
});

describe("sin cola montada", () => {
  it("responde 503 y NO crea el post", async () => {
    // El mismo criterio que `POST /content`: un post creado sin job es un post
    // que nunca se publica y que nada va a marcar como fallido. Es peor que un
    // 503, porque no se ve.
    const sinCola = await startApi({ withQueue: false });
    try {
      const antes = await sinCola.request({ method: "GET", path: "/api/v1/posts" });
      const cuantos = (antes.body?.["data"] as unknown[]).length;

      const res = await sinCola.request({
        method: "POST",
        path: `/api/v1/content/${sinCola.data.a.contentId}/schedule`,
        body: {
          scheduledAtUtc: CUANDO,
          targets: [
            {
              platform: "tiktok",
              connectionId: sinCola.data.a.connectionId,
              title: "hola",
            },
          ],
        },
      });
      expect(res.status).toBe(503);

      const despues = await sinCola.request({ method: "GET", path: "/api/v1/posts" });
      expect((despues.body?.["data"] as unknown[]).length).toBe(cuantos);
    } finally {
      await sinCola.close();
    }
  }, 180_000);
});
