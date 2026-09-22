/**
 * Paridad del enum `acquisition_tier` entre los cuatro lugares donde está
 * escrito — regresión de `P1-BRAND-013`.
 *
 * **El bug que esto impide.** `ports`/`core` llamaban al tier C
 * `C_rendered_fetch`; `db`/`contracts` lo llaman `C_page_fetch`. Nada comparaba
 * las dos listas, así que `acquisitionPlan()` podía devolver un literal que
 * Postgres rechaza con `invalid input value for enum acquisition_tier` en el
 * `INSERT`. No explotaba sólo porque el tier C está apagado hasta `OQ-16` y el
 * plan no lo incluye; el día que se encienda la bandera, sí.
 *
 * **Por qué el test vive acá y no en `ports`, que es donde está el tipo.**
 * Porque `ports` no puede importar `db` ni `contracts` —ni debe— y `core`
 * tampoco. Esa imposibilidad **es** la razón por la que el bug existió: no
 * había un solo punto del árbol de dependencias desde el que se vieran las
 * cuatro listas a la vez. La salida es no importarlas: leer los archivos como
 * **texto**. No crea dependencia de paquete, no entra en el grafo de
 * `dependency-cruiser`, y no hay build que pueda quedar viejo y tapar la
 * divergencia.
 *
 * El mismo truco lo usa `scripts/check-consistency.mjs`, que es el sitio donde
 * esto debería además vivir como invariante de repo (ver el reporte de la
 * tarea). Este test es la red de `core`: corre en `pnpm --filter @fastgram/core
 * test` aunque nadie se acuerde del script.
 *
 * **Cómo falla a propósito, si querés comprobarlo:** cambiá un literal de
 * `ACQUISITION_TIERS` en `packages/ports/src/social-reader.ts`, reconstruí
 * `ports` (`pnpm --filter @fastgram/ports build` — si no, `core` sigue leyendo
 * el `dist` viejo y el test pasa) y corré la suite.
 *
 * Se compara el **conjunto** de valores, no el orden: el orden del `pgEnum`
 * sólo le importa a Drizzle para generar migraciones, y compararlo haría fallar
 * este test por un reordenamiento inocuo. Lo que tumba un `INSERT` es que un
 * literal exista de un lado y no del otro.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ACQUISITION_TIERS } from "@fastgram/ports";

/** Raíz del monorepo, buscando hacia arriba el `pnpm-workspace.yaml`. */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "no encontré la raíz del monorepo (pnpm-workspace.yaml) desde este test",
  );
}

const ROOT = repoRoot();

function leer(rel: string): string {
  const abs = join(ROOT, rel);
  if (!existsSync(abs)) {
    // Falla ruidosa a propósito: un chequeo que no encuentra el archivo y dice
    // que todo está bien es peor que no tenerlo.
    throw new Error(`no existe ${rel} — ¿lo movieron? Actualizá este test.`);
  }
  return readFileSync(abs, "utf8");
}

/**
 * Literales de `NOMBRE = [...]` o `NOMBRE = z.enum([...])`.
 * Tira si no encuentra la lista, por el mismo motivo que {@link leer}.
 */
function literalesTs(rel: string, nombre: string): readonly string[] {
  const src = leer(rel);
  const m = new RegExp(`\\b${nombre}\\s*=\\s*(?:z\\.enum\\()?\\[([^\\]]+)\\]`).exec(src);
  const cuerpo = m?.[1];
  if (cuerpo === undefined) {
    throw new Error(`no encontré la lista \`${nombre}\` en ${rel} — ¿la renombraron?`);
  }
  return [...cuerpo.matchAll(/"([^"]+)"/g)].flatMap((x) =>
    x[1] === undefined ? [] : [x[1]],
  );
}

/**
 * Los valores que el enum tiene **en Postgres**, leyendo todas las migraciones:
 * el `CREATE TYPE` que lo define más los `ALTER TYPE ... ADD VALUE` posteriores.
 * Mirar sólo `0000` mentiría en cuanto alguien agregue un tier con un `ALTER`.
 */
function literalesSql(tipo: string): readonly string[] {
  const dir = "packages/db/drizzle";
  const archivos = readdirSync(join(ROOT, dir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const valores: string[] = [];
  let definido = false;

  for (const archivo of archivos) {
    const sql = leer(`${dir}/${archivo}`);

    const creado = new RegExp(
      `CREATE TYPE\\s+(?:"[^"]+"\\.)?"${tipo}"\\s+AS ENUM\\s*\\(([^)]+)\\)`,
      "i",
    ).exec(sql);
    const cuerpo = creado?.[1];
    if (cuerpo !== undefined) {
      definido = true;
      for (const v of cuerpo.matchAll(/'([^']+)'/g)) {
        if (v[1] !== undefined) valores.push(v[1]);
      }
    }

    const agregados = sql.matchAll(
      new RegExp(
        `ALTER TYPE\\s+(?:"[^"]+"\\.)?"${tipo}"\\s+ADD VALUE\\s+(?:IF NOT EXISTS\\s+)?'([^']+)'`,
        "gi",
      ),
    );
    for (const v of agregados) {
      if (v[1] !== undefined) valores.push(v[1]);
    }
  }

  if (!definido) {
    throw new Error(
      `ninguna migración de ${dir} define el enum \`${tipo}\` — ¿lo renombraron?`,
    );
  }
  return valores;
}

const ordenado = (xs: readonly string[]): readonly string[] => [...xs].sort();

describe("enum acquisition_tier · paridad entre paquetes (P1-BRAND-013)", () => {
  const canon = ordenado(ACQUISITION_TIERS);

  it("la lista de `@fastgram/ports` tiene los cuatro tiers de FR-011.4", () => {
    // Ancla literal: si alguien renombra un tier en ports, este caso dice cuál
    // era el valor esperado sin obligar a abrir la base.
    expect(canon).toEqual(["A_oauth", "B_public_api", "C_page_fetch", "D_assisted"]);
  });

  it("coincide con `ACQUISITION_TIER` de packages/db", () => {
    expect(
      ordenado(literalesTs("packages/db/src/schema/enums.ts", "ACQUISITION_TIER")),
    ).toEqual(canon);
  });

  it("coincide con `acquisitionTierSchema` de packages/contracts", () => {
    expect(
      ordenado(
        literalesTs("packages/contracts/src/resources/brand.ts", "acquisitionTierSchema"),
      ),
    ).toEqual(canon);
  });

  it("coincide con el enum `acquisition_tier` que las migraciones crean en Postgres", () => {
    // El que realmente rechaza el `INSERT`. Los otros tres son intenciones;
    // éste es el que manda.
    expect(ordenado(literalesSql("acquisition_tier"))).toEqual(canon);
  });

  it("`C_rendered_fetch`, el nombre viejo, no sobrevive en ninguna de las listas", () => {
    const listas = [
      ACQUISITION_TIERS,
      literalesTs("packages/db/src/schema/enums.ts", "ACQUISITION_TIER"),
      literalesTs("packages/contracts/src/resources/brand.ts", "acquisitionTierSchema"),
      literalesSql("acquisition_tier"),
    ];
    for (const lista of listas) {
      expect(lista).not.toContain("C_rendered_fetch");
    }
  });
});
