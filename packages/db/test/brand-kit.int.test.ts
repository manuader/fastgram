/**
 * `brandKitStore` — `PU-MEDIA-002`, migración `0013`.
 *
 * Sin RLS (conexión superusuaria, sin GUC) por el mismo criterio que
 * `media-normalization.int.test.ts`: lo único que aísla es el `WHERE` del
 * repositorio, y eso es lo que se mide.
 */
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { brandKitStore, type BrandKitMediaInput } from "../src/repositories/index";
import { media } from "../src/schema/index";
import { withoutCompany } from "../src/tenancy";
import { seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
let alpha: string;
let beta: string;

const crudo = <T>(fn: Parameters<typeof withoutCompany<T>>[1]): Promise<T> =>
  withoutCompany(ctx.db, fn);

function items(companyId: string, n: number): BrandKitMediaInput[] {
  return Array.from({ length: n }, (_, i) => ({
    mediaType: i === 0 ? "video" : "image",
    filename: `brand-kit-x-${String(i)}`,
    r2Url: `https://bucket.test/media/${companyId}/brand-kit/t/${String(i)}`,
    storageKey: `media/${companyId}/brand-kit/t/${String(i)}`,
    sizeMb: 0.2,
    videoDurationSec: i === 0 ? 8 : null,
    categories:
      i === 0 ? ["background-video"] : ["slideshow-image", "green-screen-background"],
  }));
}

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = (await seedCompany(ctx.db, { name: "Alpha kit" })).companyId;
  beta = (await seedCompany(ctx.db, { name: "Beta kit" })).companyId;
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("brandKitStore — PU-MEDIA-002", () => {
  it("inserta `ready` con origin `brand_kit`, y la segunda vez no duplica", async () => {
    const kit = items(alpha, 3);
    const first = await crudo(async (tx) => {
      await brandKitStore.lockCompanyBrandKit(tx, { companyId: alpha });
      return brandKitStore.insertBrandKitMedia(tx, { companyId: alpha }, kit);
    });
    expect(first).toBe(3);

    const second = await crudo(async (tx) => {
      await brandKitStore.lockCompanyBrandKit(tx, { companyId: alpha });
      return brandKitStore.insertBrandKitMedia(tx, { companyId: alpha }, kit);
    });
    expect(second).toBe(0);

    const rows = await ctx.db.select().from(media).where(eq(media.companyId, alpha));
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.origin).toBe("brand_kit");
      expect(row.status).toBe("ready");
    }
    const video = rows.find((r) => r.mediaType === "video");
    expect(video?.videoDurationSec).toBe(8);
    expect(video?.categories).toEqual(["background-video"]);
  });

  it("una fila borrada cuenta como existente: la reentrega no la resucita", async () => {
    const kit = items(alpha, 3);
    const key = kit[1]?.storageKey ?? "";
    await ctx.db
      .update(media)
      .set({ deletedAt: new Date() })
      .where(eq(media.storageKey, key));
    const inserted = await crudo((tx) =>
      brandKitStore.insertBrandKitMedia(tx, { companyId: alpha }, kit),
    );
    expect(inserted).toBe(0);
  });

  it("el scope es por marca: las claves de alpha no existen para beta", async () => {
    // Misma lista de claves (texto idéntico) consultada desde otro workspace.
    const keys = items(alpha, 3).map((i) => i.storageKey);
    const seen = await crudo((tx) =>
      brandKitStore.existingBrandKitKeys(tx, { companyId: beta }, keys),
    );
    expect(seen.size).toBe(0);
    const mine = await crudo((tx) =>
      brandKitStore.existingBrandKitKeys(tx, { companyId: alpha }, keys),
    );
    expect(mine.size).toBe(3);
  });

  it("con el lock, la segunda transacción espera a la primera y no duplica", async () => {
    // Determinista, no una carrera: A inserta y **no commitea** hasta que se lo
    // soltamos. Sin el lock, B no vería las filas sin commitear de A e
    // insertaría las mismas cuatro (trampa 37: es un INSERT). Con el lock, B
    // queda bloqueada en `lockCompanyBrandKit` hasta que A termina.
    const kit = items(beta, 4);
    let soltarA: () => void = () => {};
    const aPuedeTerminar = new Promise<void>((resolve) => {
      soltarA = resolve;
    });
    let aInserto: () => void = () => {};
    const aYaInserto = new Promise<void>((resolve) => {
      aInserto = resolve;
    });

    const a = crudo(async (tx) => {
      await brandKitStore.lockCompanyBrandKit(tx, { companyId: beta });
      const n = await brandKitStore.insertBrandKitMedia(tx, { companyId: beta }, kit);
      aInserto();
      await aPuedeTerminar;
      return n;
    });
    await aYaInserto;

    let bTermino = false;
    const b = crudo(async (tx) => {
      await brandKitStore.lockCompanyBrandKit(tx, { companyId: beta });
      return brandKitStore.insertBrandKitMedia(tx, { companyId: beta }, kit);
    }).then((n) => {
      bTermino = true;
      return n;
    });

    // La negativa primero (trampa 35): B no puede haber terminado con A abierta.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(bTermino).toBe(false);

    soltarA();
    expect(await a).toBe(4);
    expect(await b).toBe(0);
    const rows = await ctx.db.select().from(media).where(eq(media.companyId, beta));
    expect(rows).toHaveLength(4);
  });
});
