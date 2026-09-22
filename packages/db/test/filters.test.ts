/**
 * `compileFilter` — el traductor de filtro declarativo a SQL (`P1-DATA-014`).
 *
 * Se testea el **SQL que sale**, renderizado por el mismo dialecto que lo va a
 * ejecutar, y no sólo "no explotó". La razón es el caso de `{ in: [] }`: cualquier
 * versión que devolviera `undefined` ahí pasaría un test de humo y, en producción,
 * convertiría "filtrame por esta lista vacía" en "traeme todo el workspace".
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import { compileFilter } from "../src/repositories/filters";
import { contents, media } from "../src/schema/index";

const dialect = new PgDialect();

/** Renderiza a la cadena que Postgres recibiría, con los parámetros aparte. */
function render(filter: Parameters<typeof compileFilter>[1]): {
  sql: string;
  params: unknown[];
} {
  const compiled = compileFilter(contents, filter);
  if (compiled === undefined)
    throw new Error("Se esperaba una condición y salió undefined.");
  const query = dialect.sqlToQuery(compiled);
  return { sql: query.sql, params: query.params };
}

describe("nada que filtrar", () => {
  it("sin filtro no hay condición", () => {
    expect(compileFilter(contents, undefined)).toBeUndefined();
  });

  it("un filtro vacío tampoco", () => {
    expect(compileFilter(contents, {})).toBeUndefined();
  });

  it("una clave en `undefined` se ignora, no filtra por NULL", () => {
    // Importa porque las rutas arman el filtro desde query params opcionales:
    // `{ status: q.status === undefined ? undefined : { in: … } }` es el patrón.
    expect(compileFilter(contents, { status: undefined })).toBeUndefined();
  });
});

describe("operadores", () => {
  it("`eq` compara por igual y pasa el valor como parámetro", () => {
    const { sql, params } = render({ status: { eq: "BUILDING" } });
    expect(sql).toContain('"status" = $1');
    expect(params).toEqual(["BUILDING"]);
  });

  it("`in` genera un IN con un parámetro por elemento", () => {
    const { sql, params } = render({ status: { in: ["BUILDING", "READY"] } });
    expect(sql).toContain("in (");
    expect(params).toEqual(["BUILDING", "READY"]);
  });

  it("`isNull` e `isNotNull` no llevan parámetro", () => {
    expect(render({ deletedAt: { isNull: true } }).sql).toContain("is null");
    expect(render({ deletedAt: { isNotNull: true } }).sql).toContain("is not null");
  });

  it("`eq: null` se traduce a IS NULL y no a `= NULL`", () => {
    // `= NULL` es sintácticamente válido y **nunca** es verdadero, ni para las filas
    // que tienen NULL. Sale una lista vacía sin ningún error que lo delate.
    const { sql, params } = render({ deletedAt: { eq: null } });
    expect(sql).toContain("is null");
    expect(sql).not.toContain("= $1");
    expect(params).toEqual([]);
  });

  it("varias claves van en AND", () => {
    const { sql } = render({ status: { eq: "READY" }, deletedAt: { isNull: true } });
    expect(sql).toContain("and");
  });
});

describe("la lista vacía", () => {
  it("`in: []` no coincide con nada — no es 'sin filtro'", () => {
    const compiled = compileFilter(contents, { status: { in: [] } });
    expect(compiled).toBeDefined();
    expect(dialect.sqlToQuery(compiled!).sql).toContain("false");
  });

  it("y sigue sin coincidir cuando va acompañada de otra condición", () => {
    const { sql } = render({ status: { in: [] }, deletedAt: { isNull: true } });
    expect(sql).toContain("false");
  });
});

describe("lo que rechaza", () => {
  it("filtrar por `companyId` es un error, no un filtro redundante", () => {
    expect(() => compileFilter(contents, { companyId: { eq: "otro" } })).toThrow(
      /companyId/,
    );
  });

  it("una columna que no existe explota con el nombre a la vista", () => {
    // El tipo ya lo impide, pero un filtro armado desde un body JSON llega como
    // `Record<string, unknown>` y el tipo no lo mira.
    expect(() => compileFilter(contents, { nope: { eq: 1 } } as never)).toThrow(/'nope'/);
  });

  it("una columna de OTRA tabla también: el filtro se valida contra la suya", () => {
    // `mediaId` existe en el schema, pero no en `contents`. Es el error de
    // copy-paste entre dos rutas, y sin esto saldría un SQL que Postgres rechaza
    // con un mensaje mucho menos útil.
    expect(() => compileFilter(contents, { mediaId: { eq: "x" } } as never)).toThrow(
      /'mediaId'/,
    );
    expect(compileFilter(media, { mediaId: { eq: "x" } })).toBeDefined();
  });
});
