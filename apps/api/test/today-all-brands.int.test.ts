/**
 * "Today" para todas las marcas — deuda de `PU-UI-002`.
 *
 *  - `GET /calendar?brands=all` trae `errorCode`/`errorMessage` de los posts
 *    `FAILED` y `postUrl` de los publicados, de **cualquier** marca del dueño.
 *  - `GET /blitz/queue/counts?brands=all` cuenta la cola de cada marca del
 *    dueño, sin pedir relleno y sin cobrar. Una marca de **otro** dueño no
 *    aparece nunca, y pedirla por header es el mismo 404 de siempre.
 *
 * Modo personal, con el fixture de dos marcas del mismo dueño (`a` y `b`).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { blitzQueueCountsSchema, calendarSchema } from "@fastgram/contracts";
import { companies, suggestions, users, withoutCompany } from "@fastgram/db";

import { dataOf, startApi, type ApiHarness } from "./helpers/harness.js";

const HEADER = "x-fastgram-workspace";

let api: ApiHarness;
/** Una company de **otro** dueño, con cola propia. */
let foreignId: string;

beforeAll(async () => {
  api = await startApi({ mode: "personal" });
  foreignId = await withoutCompany(api.handle.db, async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        externalIdentityId: `test_${randomUUID()}`,
        email: `today-${randomUUID()}@test.local`,
        fullName: "otro dueño",
        timezone: "UTC",
      })
      .returning({ id: users.id });
    if (user === undefined) throw new Error("no se creó el user");
    const [company] = await tx
      .insert(companies)
      .values({
        name: "ajena",
        ownerUserId: user.id,
        status: "active",
        planId: "growth",
        billingAnchorDay: 1,
        timezone: "UTC",
      })
      .returning({ id: companies.id });
    if (company === undefined) throw new Error("no se creó la company");
    return company.id;
  });
}, 180_000);

afterAll(async () => {
  await api?.close();
});

beforeEach(() => {
  api.queue.reset();
});

async function encolar(companyId: string, n: number): Promise<void> {
  await withoutCompany(api.handle.db, async (tx) => {
    await tx.insert(suggestions).values(
      Array.from({ length: n }, (_, i) => ({
        companyId,
        contentType: "wall-of-text" as const,
        generatedText: `copy ${String(i)}`,
        aiExplanation: "porque sí",
      })),
    );
  });
}

describe("GET /blitz/queue/counts", () => {
  it("brands=all: una fila por marca del dueño, nunca la de otro dueño, sin relleno", async () => {
    await encolar(api.data.a.companyId, 2);
    await encolar(api.data.b.companyId, 3);
    await encolar(foreignId, 4);

    const res = await api.request({
      method: "GET",
      path: "/api/v1/blitz/queue/counts?brands=all",
    });
    expect(res.status).toBe(200);
    const rows = blitzQueueCountsSchema.parse(dataOf(res));
    const byBrand = new Map(rows.map((r) => [r.brandId, r.queued]));
    expect(byBrand).toEqual(
      new Map([
        [api.data.a.companyId, 2],
        [api.data.b.companyId, 3],
      ]),
    );
    expect(byBrand.has(foreignId)).toBe(false);
    // Leer no rellena: con la cola corta, `GET /blitz/queue` sí pediría.
    expect(api.queue.enqueued).toHaveLength(0);
  });

  it("sin brands (current): sólo la marca de la request", async () => {
    const res = await api.request({
      method: "GET",
      path: "/api/v1/blitz/queue/counts",
      headers: { [HEADER]: api.data.b.companyId },
    });
    expect(res.status).toBe(200);
    expect(blitzQueueCountsSchema.parse(dataOf(res))).toEqual([
      { brandId: api.data.b.companyId, queued: 3 },
    ]);
  });

  it("una marca de otro dueño por header: 404", async () => {
    const res = await api.request({
      method: "GET",
      path: "/api/v1/blitz/queue/counts?brands=all",
      headers: { [HEADER]: foreignId },
    });
    expect(res.status).toBe(404);
  });

  it("brands inválido: 400", async () => {
    const res = await api.request({
      method: "GET",
      path: "/api/v1/blitz/queue/counts?brands=everyone",
    });
    expect(res.status).toBe(400);
  });
});

describe("GET /calendar trae el motivo y el link de cualquier marca", () => {
  const from = Date.parse("2026-09-20T00:00:00.000Z");
  const to = Date.parse("2026-10-05T00:00:00.000Z");

  it("FAILED con errorCode/errorMessage y POSTED con postUrl, en la otra marca", async () => {
    // El fixture trae un post SCHEDULED por marca. El de `b` falla; el de `a` sale.
    await api.handle.sql`
      update posts set status = 'FAILED', error_code = 'instagram_repeated_mention',
        error_message = 'Instagram rejected a repeated mention.'
      where company_id = ${api.data.b.companyId}::uuid
    `;
    await api.handle.sql`
      update posts set status = 'POSTED', posted_at = '2026-09-22T12:00:00Z',
        post_url = 'https://www.tiktok.com/@acme/video/1', error_code = 'viejo'
      where company_id = ${api.data.a.companyId}::uuid
    `;

    const res = await api.request({
      method: "GET",
      path: `/api/v1/calendar?from=${String(from)}&to=${String(to)}&brands=all`,
    });
    expect(res.status).toBe(200);
    const cal = calendarSchema.parse(dataOf(res));
    const posts = cal.items.filter((i) => i.kind === "post");

    const failed = posts.find((i) => i.brandId === api.data.b.companyId);
    expect(failed).toMatchObject({
      status: "FAILED",
      errorCode: "instagram_repeated_mention",
      errorMessage: "Instagram rejected a repeated mention.",
    });

    const posted = posts.find((i) => i.brandId === api.data.a.companyId);
    expect(posted?.status).toBe("POSTED");
    expect(posted?.postUrl).toBe("https://www.tiktok.com/@acme/video/1");
    // Un `errorCode` que quedó de antes no se muestra en un post que salió.
    expect(posted?.errorCode).toBeUndefined();
  });
});
