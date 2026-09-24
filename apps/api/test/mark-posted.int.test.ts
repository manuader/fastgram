/**
 * `POST /posts/:id/mark-posted` — `PU-UI-002`. El borrador de TikTok que el
 * usuario terminó en la app pasa de `IN_USER_INBOX` a `POSTED`, y nada más.
 *
 * Dos arneses, uno detrás del otro (cada `startApi` re-siembra la base):
 *
 * - **personal**: `a` y `b` son marcas del mismo dueño. Se marca por la marca
 *   de la request, por `X-Fastgram-Workspace` y por `brandId` en el cuerpo.
 * - **standard**: `a` y `b` son tenants distintos. El post de `b` pedido con la
 *   key de `a` —por id o con `brandId`— es `404`, igual que un id inexistente.
 *
 * El fixture trae por marca un post de TikTok `SCHEDULED`; cada test lo pone en
 * el estado que necesita con SQL directo, porque ningún endpoint deja un post
 * en `IN_USER_INBOX` (lo hace el worker al publicar).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

const HEADER = "x-fastgram-workspace";
const NOW = Date.parse("2026-09-21T12:00:00.000Z");

async function setStatus(api: ApiHarness, postId: string, status: string): Promise<void> {
  await api.handle.sql`
    update posts set status = ${status}::post_status, posted_at = null
    where id = ${postId}::uuid
  `;
}

async function rowOf(
  api: ApiHarness,
  postId: string,
): Promise<{ status: string; postedAt: Date | null }> {
  const [row] = await api.handle.sql<
    { status: string; posted_at: string | Date | null }[]
  >`
    select status, posted_at from posts where id = ${postId}::uuid
  `;
  if (row === undefined) throw new Error(`no existe el post ${postId}`);
  // `postgres.js` sobre la conexión de `drizzle()` devuelve el timestamp como texto
  // (trampa 18): se normaliza acá para comparar instantes.
  return {
    status: row.status,
    postedAt: row.posted_at === null ? null : new Date(row.posted_at),
  };
}

const markPosted = (
  api: ApiHarness,
  postId: string,
  options: { body?: unknown; headers?: Record<string, string> } = {},
) =>
  api.request({
    method: "POST",
    path: `/api/v1/posts/${postId}/mark-posted`,
    ...(options.body === undefined ? {} : { body: options.body }),
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  });

describe("modo personal", () => {
  let api: ApiHarness;

  beforeAll(async () => {
    api = await startApi({ mode: "personal" });
  }, 180_000);

  afterAll(async () => {
    await api?.close();
  });

  it("IN_USER_INBOX → POSTED con postedAt = ahora, y devuelve el post", async () => {
    await setStatus(api, api.data.a.postId, "IN_USER_INBOX");

    const res = await markPosted(api, api.data.a.postId, { body: {} });

    expect(res.status).toBe(200);
    const post = dataOf(res);
    expect(post["_id"]).toBe(api.data.a.postId);
    expect(post["status"]).toBe("POSTED");
    expect(post["postedAt"]).toBe(NOW);
    const row = await rowOf(api, api.data.a.postId);
    expect(row.status).toBe("POSTED");
    expect(row.postedAt?.getTime()).toBe(NOW);
  });

  it("sin cuerpo también llega al handler", async () => {
    await setStatus(api, api.data.a.postId, "IN_USER_INBOX");
    const res = await markPosted(api, api.data.a.postId);
    expect(res.status, res.raw).toBe(200);
  });

  it("repetirlo es 409: ya no está en el inbox, y no se reescribe", async () => {
    await setStatus(api, api.data.a.postId, "IN_USER_INBOX");
    expect((await markPosted(api, api.data.a.postId, { body: {} })).status).toBe(200);
    const before = await rowOf(api, api.data.a.postId);

    api.clock.advanceMs(60_000);
    const again = await markPosted(api, api.data.a.postId, { body: {} });

    expect(again.status).toBe(409);
    expect(errorOf(again).code).toBe("conflict");
    const after = await rowOf(api, api.data.a.postId);
    expect(after.postedAt?.getTime()).toBe(before.postedAt?.getTime());
  });

  it.each([
    "SCHEDULED",
    "FAILED",
    "UPLOADING_TO_TIKTOK",
    "AWAITING_RECONNECT",
    "CANCELLED",
  ])("desde %s es 409 y el post no cambia", async (status) => {
    await setStatus(api, api.data.a.postId, status);

    const res = await markPosted(api, api.data.a.postId, { body: {} });

    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("conflict");
    const row = await rowOf(api, api.data.a.postId);
    expect(row.status).toBe(status);
    expect(row.postedAt).toBeNull();
  });

  it("la marca del header: el post de b con X-Fastgram-Workspace = b", async () => {
    await setStatus(api, api.data.b.postId, "IN_USER_INBOX");

    const res = await markPosted(api, api.data.b.postId, {
      body: {},
      headers: { [HEADER]: api.data.b.companyId },
    });

    expect(res.status).toBe(200);
    expect((await rowOf(api, api.data.b.postId)).status).toBe("POSTED");
  });

  it("la marca del cuerpo: el post de b con brandId = b, sin header (vista 'Today')", async () => {
    await setStatus(api, api.data.b.postId, "IN_USER_INBOX");

    const res = await markPosted(api, api.data.b.postId, {
      body: { brandId: api.data.b.companyId },
    });

    expect(res.status).toBe(200);
    expect((await rowOf(api, api.data.b.postId)).status).toBe("POSTED");
  });

  it("el post de b pedido en la marca a (sin brandId) es 404 y no se toca", async () => {
    await setStatus(api, api.data.b.postId, "IN_USER_INBOX");

    const res = await markPosted(api, api.data.b.postId, { body: {} });

    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe("not_found");
    expect((await rowOf(api, api.data.b.postId)).status).toBe("IN_USER_INBOX");
  });

  it("un brandId que no es del dueño da el mismo 404 que un post inexistente", async () => {
    await setStatus(api, api.data.a.postId, "IN_USER_INBOX");

    const ajeno = await markPosted(api, api.data.a.postId, {
      body: { brandId: randomUUID() },
    });
    const inexistente = await markPosted(api, randomUUID(), { body: {} });

    expect(ajeno.status).toBe(404);
    expect(inexistente.status).toBe(404);
    expect(ajeno.raw).toBe(inexistente.raw);
    expect((await rowOf(api, api.data.a.postId)).status).toBe("IN_USER_INBOX");
  });

  it("un id malformado es el mismo 404 byte a byte (NFR-006)", async () => {
    const basura = await markPosted(api, "no-soy-un-uuid", { body: {} });
    const inexistente = await markPosted(api, randomUUID(), { body: {} });
    expect(basura.status).toBe(404);
    expect(basura.raw).toBe(inexistente.raw);
  });

  it("un cuerpo con campos de más es 400", async () => {
    await setStatus(api, api.data.a.postId, "IN_USER_INBOX");
    const res = await markPosted(api, api.data.a.postId, {
      body: { status: "POSTED" },
    });
    expect(res.status).toBe(400);
    expect((await rowOf(api, api.data.a.postId)).status).toBe("IN_USER_INBOX");
  });
});

describe("modo standard: cross-tenant", () => {
  let api: ApiHarness;

  beforeAll(async () => {
    api = await startApi();
  }, 180_000);

  afterAll(async () => {
    await api?.close();
  });

  it("el post de otro tenant es 404 —por id o con su brandId— y no cambia", async () => {
    await setStatus(api, api.data.b.postId, "IN_USER_INBOX");

    const porId = await markPosted(api, api.data.b.postId, { body: {} });
    const conBrand = await markPosted(api, api.data.b.postId, {
      body: { brandId: api.data.b.companyId },
    });
    const inexistente = await markPosted(api, randomUUID(), { body: {} });

    // La aserción de que no cambió va primero en importancia: un 404 que igual
    // escribió sería el peor de los dos mundos.
    expect((await rowOf(api, api.data.b.postId)).status).toBe("IN_USER_INBOX");
    expect(porId.status).toBe(404);
    expect(conBrand.status).toBe(404);
    expect(porId.raw).toBe(inexistente.raw);
    expect(conBrand.raw).toBe(inexistente.raw);
  });

  it("el propio post se marca igual sin modo personal", async () => {
    await setStatus(api, api.data.a.postId, "IN_USER_INBOX");
    const res = await markPosted(api, api.data.a.postId, { body: {} });
    expect(res.status).toBe(200);
    expect(dataOf(res)["status"]).toBe("POSTED");
  });
});
