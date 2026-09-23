/**
 * `mediaNormalizationStore` — el `WHERE` de cada sentencia, **sin RLS**.
 *
 * Mismo criterio que `tenant-filter.int.test.ts`: con el GUC puesto, RLS tapa
 * un `eq(companyId)` que falte y el test de cross-tenant mide la base, no el
 * repositorio. Acá la conexión es superusuaria y sin GUC, así que lo único que
 * aísla es el filtro. Cada «no» se acompaña de una relectura de la fila
 * víctima: responder `null` y escribir igual es el bug caro.
 *
 * Los casos de condición (`status`, `storageKey`, borrado) son los que hacen
 * al handler idempotente ante reentrega y ante un `DELETE` concurrente.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { mediaNormalizationStore } from "../src/repositories/index";
import { media } from "../src/schema/index";
import { withoutCompany } from "../src/tenancy";
import { seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
let alpha: string;
let beta: string;

const NOW = new Date("2026-09-23T10:00:00.000Z");

/** Sin rol y sin GUC: saca a RLS del camino. Ver la cabecera. */
const crudo = <T>(fn: Parameters<typeof withoutCompany<T>>[1]): Promise<T> =>
  withoutCompany(ctx.db, fn);

async function video(
  companyId: string,
  overrides: Partial<typeof media.$inferInsert> = {},
): Promise<string> {
  const [row] = await ctx.db
    .insert(media)
    .values({
      companyId,
      mediaType: "video",
      filename: "clip.mov",
      r2Url: `https://bucket.test/media/${companyId}/orig.mov`,
      storageKey: `media/${companyId}/orig.mov`,
      status: "processing",
      sizeMb: 3,
      origin: "manual_upload",
      ...overrides,
    })
    .returning({ id: media.mediaId });
  if (row === undefined) throw new Error("no se creó el media");
  return row.id;
}

async function leer(mediaId: string) {
  const [row] = await ctx.db.select().from(media).where(eq(media.mediaId, mediaId));
  if (row === undefined) throw new Error("fila desaparecida");
  return row;
}

const completar = (companyId: string, mediaId: string, expected: string) =>
  crudo((tx) =>
    mediaNormalizationStore.completeMediaNormalization(tx, { companyId }, mediaId, {
      expectedStorageKey: expected,
      storageKey: `media/${companyId}/normalized/${mediaId}/x.mp4`,
      r2Url: `https://bucket.test/media/${companyId}/normalized/${mediaId}/x.mp4`,
      sizeMb: 2.5,
      videoDurationSec: 7,
      now: NOW,
    }),
  );

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = (await seedCompany(ctx.db, { name: "Alpha normalización" })).companyId;
  beta = (await seedCompany(ctx.db, { name: "Beta normalización" })).companyId;
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("aislamiento por workspace, sin RLS", () => {
  it("findMediaToNormalize no ve el asset de otro workspace", async () => {
    const id = await video(beta);
    expect(
      await crudo((tx) =>
        mediaNormalizationStore.findMediaToNormalize(tx, { companyId: alpha }, id),
      ),
    ).toBeNull();
    // Control positivo: el dueño sí lo ve. Sin esto el `null` de arriba podría
    // ser un id mal armado.
    expect(
      (
        await crudo((tx) =>
          mediaNormalizationStore.findMediaToNormalize(tx, { companyId: beta }, id),
        )
      )?.mediaId,
    ).toBe(id);
  });

  it("completeMediaNormalization no escribe el asset ajeno", async () => {
    const id = await video(beta);
    const antes = await leer(id);

    expect(await completar(alpha, id, antes.storageKey)).toBeNull();

    const despues = await leer(id);
    expect(despues.status).toBe("processing");
    expect(despues.storageKey).toBe(antes.storageKey);
    expect(despues.companyId).toBe(beta);
  });

  it("failMediaNormalization no marca el asset ajeno", async () => {
    const id = await video(beta);
    expect(
      await crudo((tx) =>
        mediaNormalizationStore.failMediaNormalization(tx, { companyId: alpha }, id, NOW),
      ),
    ).toBe(false);
    expect((await leer(id)).status).toBe("processing");
  });
});

describe("las condiciones que hacen idempotente al handler", () => {
  it("completa: ready, clave nueva, tamaño y duración", async () => {
    const id = await video(alpha);
    const escrita = await completar(alpha, id, `media/${alpha}/orig.mov`);
    expect(escrita?.status).toBe("ready");
    const fila = await leer(id);
    expect(fila.status).toBe("ready");
    expect(fila.storageKey).toBe(`media/${alpha}/normalized/${id}/x.mp4`);
    expect(fila.sizeMb).toBe(2.5);
    expect(fila.videoDurationSec).toBe(7);
  });

  it("una segunda completación no pisa la primera (ya no está processing)", async () => {
    const id = await video(alpha);
    await completar(alpha, id, `media/${alpha}/orig.mov`);
    expect(await completar(alpha, id, `media/${alpha}/orig.mov`)).toBeNull();
  });

  it("si la storageKey cambió, no completa", async () => {
    const id = await video(alpha);
    expect(await completar(alpha, id, `media/${alpha}/otra.mov`)).toBeNull();
    expect((await leer(id)).status).toBe("processing");
  });

  it("un asset borrado no se completa ni se falla", async () => {
    const id = await video(alpha, { deletedAt: NOW });
    expect(await completar(alpha, id, `media/${alpha}/orig.mov`)).toBeNull();
    expect(
      await crudo((tx) =>
        mediaNormalizationStore.failMediaNormalization(tx, { companyId: alpha }, id, NOW),
      ),
    ).toBe(false);
    expect((await leer(id)).status).toBe("processing");
  });

  it("un fallo tardío no pisa un ready", async () => {
    const id = await video(alpha, { status: "ready" });
    expect(
      await crudo((tx) =>
        mediaNormalizationStore.failMediaNormalization(tx, { companyId: alpha }, id, NOW),
      ),
    ).toBe(false);
    expect((await leer(id)).status).toBe("ready");
  });

  it("la duración nula deja la columna como estaba", async () => {
    const id = await video(alpha, { videoDurationSec: 12 });
    await crudo((tx) =>
      mediaNormalizationStore.completeMediaNormalization(tx, { companyId: alpha }, id, {
        expectedStorageKey: `media/${alpha}/orig.mov`,
        storageKey: `media/${alpha}/orig.mov`,
        r2Url: `https://bucket.test/media/${alpha}/orig.mov`,
        sizeMb: 3,
        videoDurationSec: null,
        now: NOW,
      }),
    );
    expect((await leer(id)).videoDurationSec).toBe(12);
  });
});
