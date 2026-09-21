/**
 * Escritura con scope en los repositorios — `P1-DATA-014`, contra Postgres real.
 *
 * ## Por qué corre todo como `fastgram_app`
 *
 * Igual que en `api-key-bootstrap.int.test.ts`: la conexión de los tests es
 * superusuario y saltea RLS, así que un test de aislamiento escrito sin `SET ROLE`
 * mide el `WHERE` del repositorio y **nada más**. Acá interesa la combinación de las
 * dos capas, que es la que corre en producción, así que todo pasa por
 * `withCompany(..., { role: APP_ROLE })`.
 *
 * ## Lo que estos tests persiguen
 *
 * El bug que se busca no es "devolvió lo que no era": es **"devolvió `null` y sin
 * embargo escribió"**. Un `update` cruzado que responde `null` mientras modifica la
 * fila ajena se ve idéntico a uno correcto desde el lado del llamador, y la ruta lo
 * traduce a un `404` impecable mientras corrompe datos de otro workspace. Por eso
 * cada aserción de acceso cruzado viene con una **segunda** que relee la fila víctima
 * y comprueba que está intacta.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { withCompany } from "../src/tenancy";
import {
  contentAngleRepository,
  contentRepository,
  contentTextBoxRepository,
  blitzPreferencesRepository,
} from "../src/repositories/index";
import { APP_ROLE, seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
let alpha: string;
let beta: string;

/** Una caja de texto válida según los CHECK de `content_text_boxes`. */
const textBox = (contentId: string, id: string, text: string) => ({
  id,
  contentId,
  slideIndex: 0,
  text,
  position: { x: 50, y: 50 },
  widthPercent: 80,
  font: { family: "Inter", weight: 700, size: 32 },
  color: "#FFFFFF",
  stroke: { width: 2, color: "#000000" },
  background: null,
});

/** Preferencias de Blitz válidas: los cuatro pesos de formato tienen que sumar 100. */
const preferences = (slideshow: number) => ({
  slideshowWeight: slideshow,
  wallOfTextWeight: 100 - slideshow,
  greenScreenWeight: 0,
  videoHookWeight: 0,
  remixPercentage: 50,
  ownMediaPercentage: 50,
  mentionBusinessPercentage: 50,
  influencerChance: 0,
});

const asApp = <T>(companyId: string, fn: Parameters<typeof withCompany<T>>[2]): Promise<T> =>
  withCompany(ctx.db, companyId, fn, { role: APP_ROLE });

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = (await seedCompany(ctx.db, { name: "Alpha" })).companyId;
  beta = (await seedCompany(ctx.db, { name: "Beta" })).companyId;
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("create", () => {
  it("crea la fila en el workspace del scope", async () => {
    const row = await asApp(alpha, (tx) =>
      contentRepository.create(tx, { companyId: alpha }, { type: "slideshow" }),
    );
    expect(row.companyId).toBe(alpha);
    expect(row.status).toBe("BUILDING");
    expect(row.revision).toBe(1);
  });

  it("rechaza un `companyId` en los valores en vez de obedecerlo", async () => {
    // El tipo ya lo excluye; esto cubre el patch armado desde un body JSON, donde el
    // tipo no mira. La alternativa —ignorarlo en silencio— dejaría creer al llamador
    // que escribió donde pidió.
    await expect(
      asApp(alpha, (tx) =>
        contentRepository.create(tx, { companyId: alpha }, {
          type: "slideshow",
          companyId: beta,
        } as never),
      ),
    ).rejects.toThrow(/companyId/);
  });

  it("`createMany` con lista vacía no toca la base", async () => {
    const rows = await asApp(alpha, (tx) =>
      contentRepository.createMany(tx, { companyId: alpha }, []),
    );
    expect(rows).toEqual([]);
  });

  it("`createMany` inserta todas en el workspace del scope", async () => {
    const content = await asApp(alpha, (tx) =>
      contentRepository.create(tx, { companyId: alpha }, { type: "slideshow" }),
    );
    const boxes = await asApp(alpha, (tx) =>
      contentTextBoxRepository.createMany(tx, { companyId: alpha }, [
        textBox(content.id, "slide-0-text-0", "uno"),
        textBox(content.id, "slide-0-text-1", "dos"),
      ]),
    );
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => b.companyId === alpha)).toBe(true);
  });
});

describe("update", () => {
  it("actualiza y mueve `updatedAt`", async () => {
    const created = await asApp(alpha, (tx) =>
      contentRepository.create(tx, { companyId: alpha }, { type: "slideshow" }),
    );
    const updated = await asApp(alpha, (tx) =>
      contentRepository.update(tx, { companyId: alpha }, created.id, {
        status: "CREATED",
      }),
    );
    expect(updated?.status).toBe("CREATED");
    // Sin `$onUpdate` en el schema, si el repositorio no la pone no la pone nadie.
    expect(updated!.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  it("un patch vacío devuelve la fila y NO mueve `updatedAt`", async () => {
    const created = await asApp(alpha, (tx) =>
      contentRepository.create(tx, { companyId: alpha }, { type: "slideshow" }),
    );
    const same = await asApp(alpha, (tx) =>
      contentRepository.update(tx, { companyId: alpha }, created.id, {}),
    );
    // Mover la fecha diría que algo cambió, y no cambió nada.
    expect(same?.updatedAt.getTime()).toBe(created.updatedAt.getTime());
  });

  it("no acepta cambiar el id", async () => {
    const created = await asApp(alpha, (tx) =>
      contentRepository.create(tx, { companyId: alpha }, { type: "slideshow" }),
    );
    await expect(
      asApp(alpha, (tx) =>
        contentRepository.update(tx, { companyId: alpha }, created.id, {
          id: randomUUID(),
        } as never),
      ),
    ).rejects.toThrow(/id/);
  });

  it("NO edita una fila borrada: un PATCH no resucita contenido", async () => {
    // Sin el `deletedAt is null` en el WHERE, la fila quedaría editada, con
    // `deletedAt` puesto: invisible en los listados y viva en la base.
    const created = await asApp(alpha, (tx) =>
      contentRepository.create(tx, { companyId: alpha }, { type: "slideshow" }),
    );
    await asApp(alpha, (tx) =>
      contentRepository.softDelete(tx, { companyId: alpha }, created.id),
    );

    const updated = await asApp(alpha, (tx) =>
      contentRepository.update(tx, { companyId: alpha }, created.id, {
        generatedText: "editado después de borrar",
      }),
    );
    expect(updated).toBeNull();

    const row = await asApp(alpha, (tx) =>
      contentRepository.findById(tx, { companyId: alpha }, created.id, {
        includeDeleted: true,
      }),
    );
    expect(row?.generatedText).toBeNull();
  });
});

describe("acceso cruzado", () => {
  it("`update` sobre una fila ajena devuelve null Y NO la modifica", async () => {
    const victima = await asApp(beta, (tx) =>
      contentRepository.create(tx, { companyId: beta }, {
        type: "slideshow",
        generatedText: "original de beta",
      }),
    );

    const resultado = await asApp(alpha, (tx) =>
      contentRepository.update(tx, { companyId: alpha }, victima.id, {
        generatedText: "escrito por alpha",
      }),
    );
    expect(resultado).toBeNull();

    // La mitad que importa: `null` no alcanza si abajo se escribió igual.
    const despues = await asApp(beta, (tx) =>
      contentRepository.findById(tx, { companyId: beta }, victima.id),
    );
    expect(despues?.generatedText).toBe("original de beta");
    expect(despues?.updatedAt.getTime()).toBe(victima.updatedAt.getTime());
  });

  it("`softDelete` sobre una fila ajena devuelve false Y NO la borra", async () => {
    const victima = await asApp(beta, (tx) =>
      contentRepository.create(tx, { companyId: beta }, { type: "slideshow" }),
    );
    const ok = await asApp(alpha, (tx) =>
      contentRepository.softDelete(tx, { companyId: alpha }, victima.id),
    );
    expect(ok).toBe(false);

    const despues = await asApp(beta, (tx) =>
      contentRepository.findById(tx, { companyId: beta }, victima.id),
    );
    expect(despues).not.toBeNull();
    expect(despues?.deletedAt).toBeNull();
  });

  it("`hardDelete` sobre una fila ajena devuelve false Y NO la borra", async () => {
    const victima = await asApp(beta, (tx) =>
      contentAngleRepository.create(tx, { companyId: beta }, { title: "Ángulo de beta" }),
    );
    const ok = await asApp(alpha, (tx) =>
      contentAngleRepository.hardDelete(tx, { companyId: alpha }, victima.id),
    );
    expect(ok).toBe(false);

    const despues = await asApp(beta, (tx) =>
      contentAngleRepository.findById(tx, { companyId: beta }, victima.id),
    );
    expect(despues).not.toBeNull();
  });

  it("`upsert` NO pisa la fila de otro workspace — el `setWhere`", async () => {
    // El caso más filoso de todos. `content_text_boxes` tiene PK `(contentId, id)`:
    // `companyId` **no** está en el target del ON CONFLICT, así que sin el `setWhere`
    // el conflicto resolvería en un UPDATE sobre la fila ajena. Que la PK sea
    // adivinable (`slide-0-text-0`) lo vuelve un vector real, no teórico.
    const contenidoBeta = await asApp(beta, (tx) =>
      contentRepository.create(tx, { companyId: beta }, { type: "slideshow" }),
    );
    const cajaBeta = await asApp(beta, (tx) =>
      contentTextBoxRepository.create(
        tx,
        { companyId: beta },
        textBox(contenidoBeta.id, "slide-0-text-0", "texto de beta"),
      ),
    );

    const resultado = await asApp(alpha, (tx) =>
      contentTextBoxRepository.upsert(
        tx,
        { companyId: alpha },
        textBox(contenidoBeta.id, "slide-0-text-0", "texto inyectado por alpha"),
      ),
    );
    expect(resultado).toBeNull();

    const despues = await asApp(beta, (tx) =>
      contentTextBoxRepository.findById(tx, { companyId: beta }, cajaBeta.id),
    );
    expect(despues?.text).toBe("texto de beta");
  });
});

describe("upsert", () => {
  it("inserta cuando no existe y actualiza cuando existe", async () => {
    const primera = await asApp(alpha, (tx) =>
      blitzPreferencesRepository.upsert(tx, { companyId: alpha }, preferences(70) as never),
    );
    expect(primera?.slideshowWeight).toBe(70);

    const segunda = await asApp(alpha, (tx) =>
      blitzPreferencesRepository.upsert(tx, { companyId: alpha }, preferences(40) as never),
    );
    expect(segunda?.slideshowWeight).toBe(40);

    const total = await asApp(alpha, (tx) =>
      blitzPreferencesRepository.count(tx, { companyId: alpha }),
    );
    expect(total).toBe(1);
  });

  it("explota si la tabla no declara `upsertTarget`", async () => {
    // Deducirlo de `id` sería un ON CONFLICT que Postgres rechaza en tiempo de
    // ejecución. Un error de programación se ve mejor acá.
    await expect(
      asApp(alpha, (tx) =>
        contentRepository.upsert(tx, { companyId: alpha }, { type: "slideshow" }),
      ),
    ).rejects.toThrow(/upsertTarget/);
  });
});

describe("hardDelete", () => {
  it("borra de verdad en una tabla sin soft-delete", async () => {
    const angulo = await asApp(alpha, (tx) =>
      contentAngleRepository.create(tx, { companyId: alpha }, { title: "Para borrar" }),
    );
    expect(
      await asApp(alpha, (tx) =>
        contentAngleRepository.hardDelete(tx, { companyId: alpha }, angulo.id),
      ),
    ).toBe(true);
    expect(
      await asApp(alpha, (tx) =>
        contentAngleRepository.findById(tx, { companyId: alpha }, angulo.id),
      ),
    ).toBeNull();
  });

  it("se niega en una tabla con soft-delete", async () => {
    // PRD §9.4 pide que estas filas se puedan excluir de los listados, no que
    // desaparezcan. Dejar las dos operaciones disponibles invita a elegir mal.
    await expect(
      asApp(alpha, (tx) =>
        contentRepository.hardDelete(tx, { companyId: alpha }, randomUUID()),
      ),
    ).rejects.toThrow(/softDelete/);
  });
});

describe("filtros y paginación numerada", () => {
  it("el filtro filtra y sigue dentro del workspace", async () => {
    const mio = await asApp(alpha, (tx) =>
      contentRepository.create(tx, { companyId: alpha }, { type: "video-hook" }),
    );
    await asApp(beta, (tx) =>
      contentRepository.create(tx, { companyId: beta }, { type: "video-hook" }),
    );

    const page = await asApp(alpha, (tx) =>
      contentRepository.list(tx, { companyId: alpha }, {
        filter: { type: { in: ["video-hook"] } },
      }),
    );
    expect(page.items.map((r) => r.id)).toContain(mio.id);
    expect(page.items.every((r) => r.companyId === alpha)).toBe(true);
    expect(page.items.every((r) => r.type === "video-hook")).toBe(true);
  });

  it("`in: []` no devuelve nada — y ésta es la regresión que importa", async () => {
    // Si `compileFilter` devolviera `undefined` para la lista vacía, esto traería el
    // workspace entero con un `200` y nadie lo notaría hasta ver la lista.
    const page = await asApp(alpha, (tx) =>
      contentRepository.list(tx, { companyId: alpha }, { filter: { type: { in: [] } } }),
    );
    expect(page.items).toEqual([]);
  });

  it("`listByPage` cuenta y pagina sobre el mismo conjunto filtrado", async () => {
    // Workspace propio: los totales son aserciones exactas, y contar filas que
    // dejaron otros tests hace que este falle cuando alguien agrega uno más arriba.
    const { companyId } = await seedCompany(ctx.db, { name: "Paginado" });
    const scope = { companyId };
    for (let i = 0; i < 5; i += 1) {
      await asApp(companyId, (tx) =>
        contentAngleRepository.create(tx, scope, { title: `Ángulo ${i}` }),
      );
    }

    const primera = await asApp(companyId, (tx) =>
      contentAngleRepository.listByPage(tx, scope, { page: 1, limit: 2 }),
    );
    expect(primera.items).toHaveLength(2);
    expect(primera.totalItems).toBe(5);
    expect(primera.totalPages).toBe(3);
    expect(primera.hasMore).toBe(true);

    const ultima = await asApp(companyId, (tx) =>
      contentAngleRepository.listByPage(tx, scope, { page: 3, limit: 2 }),
    );
    expect(ultima.items).toHaveLength(1);
    expect(ultima.hasMore).toBe(false);

    // Las páginas no se solapan: es lo único que hace que "Page 2" signifique algo.
    const segunda = await asApp(companyId, (tx) =>
      contentAngleRepository.listByPage(tx, scope, { page: 2, limit: 2 }),
    );
    const ids = [...primera.items, ...segunda.items, ...ultima.items].map((r) => r.id);
    expect(new Set(ids).size).toBe(5);
  });
});
