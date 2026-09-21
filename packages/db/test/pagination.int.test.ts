/**
 * Paginación por cursor contra Postgres — PRD §9.10, P1-DATA-011.
 *
 * Lo que se prueba acá y no se puede probar sin base: que el cursor sigue siendo
 * **estable mientras entran filas**. Es el caso real del producto —la cola de discovery
 * se rellena en background mientras el usuario pagina— y es exactamente donde `OFFSET`
 * falla en silencio: repite o saltea filas y nadie lo nota hasta que un usuario avisa
 * que vio dos veces lo mismo.
 */

import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { contentAngles } from "../src/schema/index";
import { contentAngleRepository, contentRepository } from "../src/repositories/index";
import { contents } from "../src/schema/index";
import { APP_ROLE, withCompany } from "../src/tenancy";
import { seedCompany, startTestDatabase, type TestDatabase } from "./helpers/postgres";

let ctx: TestDatabase;
let companyId: string;

const TOTAL = 25;

beforeAll(async () => {
  ctx = await startTestDatabase();
  const seeded = await seedCompany(ctx.db, { name: "Paginación" });
  companyId = seeded.companyId;

  // Fechas explícitas y separadas: el orden esperado tiene que ser inequívoco.
  const base = Date.UTC(2026, 0, 1);
  await ctx.db.insert(contentAngles).values(
    Array.from({ length: TOTAL }, (_, i) => ({
      id: randomUUID(),
      companyId,
      title: `Ángulo ${String(i).padStart(2, "0")}`,
      createdAt: new Date(base + i * 60_000),
      updatedAt: new Date(base + i * 60_000),
    })),
  );
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

const scope = () => ({ companyId });

describe("contrato de paginación", () => {
  it("default 20, cursor no nulo y hasMore true cuando falta más", async () => {
    const page = await withCompany(
      ctx.db,
      companyId,
      (tx) => contentAngleRepository.list(tx, scope()),
      { role: APP_ROLE },
    );
    expect(page.items).toHaveLength(20);
    expect(page.hasMore).toBe(true);
    expect(page.cursor).not.toBeNull();
  });

  it("clampa el límite a 100 y lo sube a 1 (PRD §9.10)", async () => {
    const [big, tiny] = await withCompany(
      ctx.db,
      companyId,
      async (tx) => [
        await contentAngleRepository.list(tx, scope(), { limit: 1_000 }),
        await contentAngleRepository.list(tx, scope(), { limit: 0 }),
      ],
      { role: APP_ROLE },
    );
    expect(big.items).toHaveLength(TOTAL);
    expect(big.hasMore).toBe(false);
    expect(big.cursor).toBeNull();
    expect(tiny.items).toHaveLength(1);
  });

  it("recorre todo sin repetir ni saltear", async () => {
    const seen = await withCompany(
      ctx.db,
      companyId,
      async (tx) => {
        const ids: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 20; guard += 1) {
          const page = await contentAngleRepository.list(tx, scope(), {
            limit: 7,
            cursor,
          });
          ids.push(...page.items.map((row) => row.id));
          cursor = page.cursor;
          if (!page.hasMore) break;
        }
        return ids;
      },
      { role: APP_ROLE },
    );

    expect(seen).toHaveLength(TOTAL);
    expect(new Set(seen).size).toBe(TOTAL);
  });

  it("ordena descendente por createdAt: lo más nuevo primero", async () => {
    const page = await withCompany(
      ctx.db,
      companyId,
      (tx) => contentAngleRepository.list(tx, scope(), { limit: 3 }),
      { role: APP_ROLE },
    );
    expect(page.items.map((r) => r.title)).toEqual([
      "Ángulo 24",
      "Ángulo 23",
      "Ángulo 22",
    ]);
  });
});

describe("estabilidad ante inserciones concurrentes", () => {
  it("una fila nueva entre página y página no rompe el recorrido", async () => {
    // Página 1.
    const first = await withCompany(
      ctx.db,
      companyId,
      (tx) => contentAngleRepository.list(tx, scope(), { limit: 10 }),
      { role: APP_ROLE },
    );
    expect(first.items).toHaveLength(10);

    // Mientras el cliente mira la página 1, entran 5 filas nuevas (más nuevas que
    // todo lo existente). Es literalmente el refill de la cola de discovery.
    const intrudersBase = Date.UTC(2026, 0, 2);
    await ctx.db.insert(contentAngles).values(
      Array.from({ length: 5 }, (_, i) => ({
        id: randomUUID(),
        companyId,
        title: `Intruso ${i}`,
        createdAt: new Date(intrudersBase + i * 1_000),
        updatedAt: new Date(intrudersBase + i * 1_000),
      })),
    );

    // Página 2 con el cursor de antes.
    const second = await withCompany(
      ctx.db,
      companyId,
      (tx) =>
        contentAngleRepository.list(tx, scope(), { limit: 10, cursor: first.cursor }),
      { role: APP_ROLE },
    );

    const firstIds = new Set(first.items.map((r) => r.id));
    const overlap = second.items.filter((r) => firstIds.has(r.id));

    // Lo que `OFFSET` habría roto: con offset 10, las 5 filas nuevas corren todo y la
    // página 2 habría repetido 5 de las que el usuario ya vio.
    expect(overlap).toEqual([]);
    expect(second.items.every((r) => !r.title.startsWith("Intruso"))).toBe(true);
    expect(second.items.map((r) => r.title)).toEqual([
      "Ángulo 14",
      "Ángulo 13",
      "Ángulo 12",
      "Ángulo 11",
      "Ángulo 10",
      "Ángulo 09",
      "Ángulo 08",
      "Ángulo 07",
      "Ángulo 06",
      "Ángulo 05",
    ]);
  });

  it("desempata por id cuando varias filas comparten createdAt exacto", async () => {
    const other = await seedCompany(ctx.db, { name: "Empates" });
    const sameInstant = new Date(Date.UTC(2026, 5, 1, 12, 0, 0));
    await ctx.db.insert(contentAngles).values(
      Array.from({ length: 12 }, () => ({
        id: randomUUID(),
        companyId: other.companyId,
        title: "Mismo instante",
        createdAt: sameInstant,
        updatedAt: sameInstant,
      })),
    );

    const ids = await withCompany(
      ctx.db,
      other.companyId,
      async (tx) => {
        const collected: string[] = [];
        let cursor: string | null = null;
        for (let guard = 0; guard < 10; guard += 1) {
          const page = await contentAngleRepository.list(
            tx,
            { companyId: other.companyId },
            { limit: 5, cursor },
          );
          collected.push(...page.items.map((r) => r.id));
          cursor = page.cursor;
          if (!page.hasMore) break;
        }
        return collected;
      },
      { role: APP_ROLE },
    );

    // Sin el desempate por id, doce filas con el mismo `createdAt` harían que el
    // cursor no avance o repita el bloque entero.
    expect(ids).toHaveLength(12);
    expect(new Set(ids).size).toBe(12);
  });
});

describe("soft-delete (P1-DATA-012 · PRD §9.4)", () => {
  it("una fila borrada desaparece de los listados por defecto", async () => {
    const seeded = await seedCompany(ctx.db, { name: "Soft delete" });
    const keptId = randomUUID();
    const goneId = randomUUID();
    await ctx.db.insert(contents).values([
      { id: keptId, companyId: seeded.companyId, type: "slideshow" },
      { id: goneId, companyId: seeded.companyId, type: "custom" },
    ]);

    const result = await withCompany(
      ctx.db,
      seeded.companyId,
      async (tx) => {
        const scoped = { companyId: seeded.companyId };
        const deleted = await contentRepository.softDelete(tx, scoped, goneId);
        return {
          deleted,
          listed: await contentRepository.list(tx, scoped),
          withDeleted: await contentRepository.list(tx, scoped, {
            includeDeleted: true,
          }),
          byId: await contentRepository.findById(tx, scoped, goneId),
          byIdIncluding: await contentRepository.findById(tx, scoped, goneId, {
            includeDeleted: true,
          }),
          reDeleted: await contentRepository.softDelete(tx, scoped, goneId),
        };
      },
      { role: APP_ROLE },
    );

    expect(result.deleted).toBe(true);
    expect(result.listed.items.map((r) => r.id)).toEqual([keptId]);
    expect(result.withDeleted.items).toHaveLength(2);
    expect(result.byId).toBeNull();
    expect(result.byIdIncluding?.id).toBe(goneId);
    // Borrar dos veces no es un error, pero tampoco miente diciendo que borró.
    expect(result.reDeleted).toBe(false);
  });
});
