/**
 * `lockPost` bajo concurrencia — `NFR-005`, `NFR-015`, `DATA-020`.
 *
 * ## Por qué hay un archivo entero para un `SELECT … FOR UPDATE`
 *
 * Por lo mismo que `content-build.int.test.ts`, sólo que acá el precio de
 * perder la carrera es más alto: **publicar no es idempotente**. El job tiene
 * `maxAttempts: 1` porque un segundo intento puede dejar dos posts en la cuenta
 * del usuario, y eso no se deshace desde este lado.
 *
 * Sin el bloqueo, con READ COMMITTED:
 *
 * ```
 *   worker: lee el post, status = SCHEDULED
 *   api:    cancel → status = CANCELLED
 *   worker: publica igual y escribe POSTED   ← o al revés, y el cancel pisa
 * ```
 *
 * Los dos finales son el mismo bug: un post publicado que la UI muestra como
 * cancelado. Los tests del handler no pueden verlo —sus transacciones son
 * cortas y se ordenan solas— así que la única forma de medirlo es desde acá,
 * donde se puede meter una pausa **dentro** de la transacción.
 */

import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { postPublishStore } from "../src/repositories/index";
import { connections, contents, posts } from "../src/schema/index";
import { withCompany } from "../src/tenancy";
import {
  APP_ROLE,
  seedCompany,
  startTestDatabase,
  type TestDatabase,
} from "./helpers/postgres";

let ctx: TestDatabase;
let companyId: string;
let contentId: string;
let connectionId: string;

const asApp = <T>(id: string, fn: Parameters<typeof withCompany<T>>[2]): Promise<T> =>
  withCompany(ctx.db, id, fn, { role: APP_ROLE });

async function nuevoPost(): Promise<string> {
  return asApp(companyId, async (tx) => {
    const [row] = await tx
      .insert(posts)
      .values({
        companyId,
        contentId,
        platform: "tiktok",
        accountType: "oauth",
        connectionId,
        scheduledAtUtc: new Date("2026-10-01T10:00:00.000Z"),
        status: "SCHEDULED",
      })
      .returning({ id: posts.id });
    if (row === undefined) throw new Error("no se creó el post");
    return row.id;
  });
}

beforeAll(async () => {
  ctx = await startTestDatabase();
  companyId = (await seedCompany(ctx.db, { name: "Publicación" })).companyId;

  contentId = randomUUID();
  await ctx.db.insert(contents).values({ id: contentId, companyId, type: "slideshow" });

  connectionId = randomUUID();
  await ctx.db.insert(connections).values({
    id: connectionId,
    companyId,
    platform: "tiktok",
    platformUserId: "u1",
    platformUsername: "handle",
  });
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("lockPost", () => {
  it("devuelve la fila entera del workspace", async () => {
    const id = await nuevoPost();
    const row = await asApp(companyId, (tx) =>
      postPublishStore.lockPost(tx, { companyId }, id),
    );
    expect(row?.id).toBe(id);
    expect(row?.status).toBe("SCHEDULED");
    // El handler necesita esto para armar el `PublishAccountRef`; si `lockPost`
    // proyectara, la lista habría que mantenerla sincronizada a mano.
    expect(row?.connectionId).toBe(connectionId);
    expect(row?.platform).toBe("tiktok");
    expect(row?.externalPostId).toBeNull();
  });

  it("no devuelve el de otro workspace (las dos capas juntas)", async () => {
    // Si esto trajera la fila, un payload manipulado en la cola alcanzaría para
    // publicar en la cuenta de otro cliente. No es un 403: desde acá una fila
    // ajena y una inexistente son indistinguibles a propósito (§9.2).
    const otro = (await seedCompany(ctx.db, { name: "Ajeno" })).companyId;
    const id = await nuevoPost();

    const row = await asApp(otro, (tx) =>
      postPublishStore.lockPost(tx, { companyId: otro }, id),
    );
    expect(row).toBeNull();
  });

  it("…y con RLS fuera del camino tampoco: el WHERE aísla por sí solo", async () => {
    // El de arriba NO mide este repositorio: corre como `fastgram_app` con el
    // GUC puesto, así que RLS tapa el agujero aunque el `where` no tenga el
    // `companyId` (verificado quitándolo: sigue verde). Éste corre como
    // superusuario, con RLS fuera del camino, y entonces lo único que aísla es
    // el `WHERE` de `lockPost`.
    const otro = (await seedCompany(ctx.db, { name: "Ajeno 2" })).companyId;
    const id = await nuevoPost();

    const row = await postPublishStore.lockPost(ctx.db, { companyId: otro }, id);
    expect(row).toBeNull();
  });

  it("SÍ devuelve un post en estado terminal — la decisión es del handler", async () => {
    // `posts` no tiene soft-delete: `DELETED` y `CANCELLED` son valores del enum
    // de estado. Filtrarlos acá le sacaría al handler la información con la que
    // decide no publicar, que es justo lo que este bloqueo protege.
    const id = await nuevoPost();
    await asApp(companyId, (tx) =>
      tx.update(posts).set({ status: "CANCELLED" }).where(eq(posts.id, id)),
    );
    const row = await asApp(companyId, (tx) =>
      postPublishStore.lockPost(tx, { companyId }, id),
    );
    expect(row?.status).toBe("CANCELLED");
  });
});

describe("concurrencia — el post publicado que la UI muestra como cancelado", () => {
  it("el cancel espera a que el handler confirme", async () => {
    const id = await nuevoPost();

    // Dos transacciones que leen el estado, esperan, y escriben según lo que
    // leyeron. Con el bloqueo, la segunda ve `POSTED` y no lo pisa. Sin él, las
    // dos leen `SCHEDULED` y la última en escribir gana.
    const publicar = () =>
      asApp(companyId, async (tx) => {
        const row = await postPublishStore.lockPost(tx, { companyId }, id);
        if (row === null) throw new Error("el post tiene que estar");
        if (row.status !== "SCHEDULED") return;
        await new Promise((r) => setTimeout(r, 60));
        await tx
          .update(posts)
          .set({ status: "POSTED", externalPostId: "plat_1" })
          .where(eq(posts.id, id));
      });

    const cancelar = () =>
      asApp(companyId, async (tx) => {
        const row = await postPublishStore.lockPost(tx, { companyId }, id);
        if (row === null) throw new Error("el post tiene que estar");
        // Un post ya publicado no se cancela desde acá: eso es `cancel` contra
        // la plataforma, y necesita el `externalPostId`.
        if (row.status !== "SCHEDULED") return;
        await new Promise((r) => setTimeout(r, 60));
        await tx.update(posts).set({ status: "CANCELLED" }).where(eq(posts.id, id));
      });

    await Promise.all([publicar(), cancelar()]);

    const final = await asApp(companyId, (tx) =>
      postPublishStore.lockPost(tx, { companyId }, id),
    );
    // Cuál de los dos ganó es indeterminado y no es lo que se afirma. Lo que se
    // afirma es que el estado y el id externo son **coherentes entre sí**: sin
    // el bloqueo aparece el par imposible `CANCELLED` + `plat_1`, que es el post
    // que salió y la UI muestra como cancelado.
    expect(["POSTED", "CANCELLED"]).toContain(final?.status);
    if (final?.status === "POSTED") {
      expect(final.externalPostId).toBe("plat_1");
    } else {
      expect(final?.externalPostId).toBeNull();
    }
  });

  it("y el bloqueo no cruza filas: dos posts distintos no se esperan", async () => {
    // La otra mitad. Un lock por tabla en vez de por fila haría que la
    // publicación de un cliente frenara la de otro, sin que nada falle.
    const a = await nuevoPost();
    const b = await nuevoPost();

    const tocar = (id: string) =>
      asApp(companyId, async (tx) => {
        await postPublishStore.lockPost(tx, { companyId }, id);
        await new Promise((r) => setTimeout(r, 120));
      });

    const empezo = Date.now();
    await Promise.all([tocar(a), tocar(b)]);
    // Si se serializaran, esto tardaría ~240 ms. El margen es amplio a
    // propósito: lo que se afirma es que NO se serializan.
    expect(Date.now() - empezo).toBeLessThan(220);
  });
});
