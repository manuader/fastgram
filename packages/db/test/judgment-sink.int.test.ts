/**
 * El sink de `DATA-033` contra Postgres — `P1-JUDGE-005`, PRD §9.15 y §25.4.
 *
 * ## Qué mide este archivo que los tests del decorador no pueden medir
 *
 * Los 8 tests de `recording-judgment.test.ts` corren contra un `MemorySink`: un
 * array. Ahí *todo* anda — no hay enums, ni `integer`, ni transacciones, ni RLS.
 * Las tres cosas que pueden romper `DATA-033` en producción sólo existen de este
 * lado:
 *
 *  1. **Un fallo de escritura que arrastra la transacción del llamador.** El
 *     decorador se traga el error del sink, así que la decisión sobrevive *si el
 *     fallo se quedó adentro del sink*. Con un array eso es trivialmente cierto;
 *     con Postgres depende de quién abrió la transacción. Los dos tests de
 *     "no hunde la decisión" miden justamente eso, y el segundo demuestra que el
 *     primero mide algo: el mismo fallo, corrido en la transacción del llamador,
 *     la aborta entera.
 *  2. **El escalón entre el puerto y el schema.** `JudgmentProvenance.adapter` es
 *     `string` abierto; la columna es un enum de tres valores.
 *  3. **El aislamiento por workspace**, que con el GUC puesto lo sostiene RLS
 *     aunque el `WHERE` no exista. Por eso hay un test sin GUC.
 */

import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createJudgmentSink,
  judgmentRecordRepository,
  writeJudgmentRecord,
  type JudgmentRecordInput,
} from "../src/repositories/index.js";
import { contentAngles, judgmentRecords } from "../src/schema/index.js";
import { withCompany } from "../src/tenancy.js";
import {
  APP_ROLE,
  seedCompany,
  startTestDatabase,
  type TestDatabase,
} from "./helpers/postgres.js";

let ctx: TestDatabase;
let alpha: string;
let beta: string;

/**
 * Un `stateHash` con la forma real (64 hex), distinto por test.
 *
 * No usa `hashState` del decorador —este paquete no puede importar
 * `@fastgram/adapters`— y no hace falta: que el hash sea canónico es propiedad del
 * decorador y ya tiene sus tests. Acá el hash es sólo la etiqueta con la que cada
 * test encuentra su fila sin depender del orden.
 */
const hash = (seed: string): string => createHash("sha256").update(seed).digest("hex");

function entrada(over: Partial<JudgmentRecordInput> = {}): JudgmentRecordInput {
  return {
    companyId: alpha,
    decisionPoint: "DP-001",
    subjectType: "trending_item",
    subjectId: "it_9",
    adapter: "stub",
    model: "stub-1",
    answers: {
      formato: {
        kind: "choice",
        value: "slideshow",
        probabilities: { slideshow: 0.8, "video-hook": 0.2 },
        confidence: 0.8,
      },
    },
    stateHash: hash("abc"),
    inputTokens: 120,
    latencyMs: 42,
    ...over,
  };
}

const asApp = <T>(id: string, fn: Parameters<typeof withCompany<T>>[2]): Promise<T> =>
  withCompany(ctx.db, id, fn, { role: APP_ROLE });

beforeAll(async () => {
  ctx = await startTestDatabase();
  alpha = (await seedCompany(ctx.db, { name: "Alpha" })).companyId;
  beta = (await seedCompany(ctx.db, { name: "Beta" })).companyId;
}, 180_000);

afterAll(async () => {
  await ctx?.stop();
});

describe("escribe la fila que DATA-033 describe", () => {
  it("con el sujeto, la procedencia, las respuestas y las dos métricas", async () => {
    const sink = createJudgmentSink(ctx.db, { role: APP_ROLE });
    await sink.record(entrada({ stateHash: hash("fila-completa") }));

    const [fila] = await asApp(alpha, (tx) =>
      tx
        .select()
        .from(judgmentRecords)
        .where(sql`${judgmentRecords.stateHash} = ${hash("fila-completa")}`),
    );

    expect(fila?.companyId).toBe(alpha);
    expect(fila?.decisionPoint).toBe("DP-001");
    expect(fila?.subjectType).toBe("trending_item");
    expect(fila?.subjectId).toBe("it_9");
    expect(fila?.adapter).toBe("stub");
    expect(fila?.model).toBe("stub-1");
    expect(fila?.inputTokens).toBe(120);
    expect(fila?.latencyMs).toBe(42);
    // `answers` es el dato que §25.4 recalcula: tiene que volver igual, no parecido.
    expect(fila?.answers).toEqual({
      formato: {
        kind: "choice",
        value: "slideshow",
        probabilities: { slideshow: 0.8, "video-hook": 0.2 },
        confidence: 0.8,
      },
    });
    expect(fila?.createdAt).toBeInstanceOf(Date);
  });

  it("sin `subjectId` ni `inputTokens` deja NULL, no cero", async () => {
    // El stub no reporta tokens y hay sujetos sin id. Un 0 en `inputTokens` sería
    // un dato falso en la única columna con la que §25.4 compara coste.
    const sink = createJudgmentSink(ctx.db, { role: APP_ROLE });
    const { companyId, decisionPoint, subjectType, adapter, model, answers, latencyMs } =
      entrada();
    await sink.record({
      companyId,
      decisionPoint,
      subjectType,
      adapter,
      model,
      answers,
      latencyMs,
      stateHash: hash("sin-opcionales"),
    });

    const [fila] = await asApp(alpha, (tx) =>
      tx
        .select()
        .from(judgmentRecords)
        .where(sql`${judgmentRecords.stateHash} = ${hash("sin-opcionales")}`),
    );
    expect(fila?.subjectId).toBeNull();
    expect(fila?.inputTokens).toBeNull();
  });

  it("redondea una latencia fraccionaria en vez de perder el registro", async () => {
    // La columna es `integer`. Un `12.7` hace fallar el INSERT, y ese fallo lo
    // absorbe el decorador: se perderían todos los registros de ese adaptador sin
    // que nada avise.
    const sink = createJudgmentSink(ctx.db, { role: APP_ROLE });
    await sink.record(entrada({ latencyMs: 12.7, stateHash: hash("redondeo") }));

    const [fila] = await asApp(alpha, (tx) =>
      tx
        .select()
        .from(judgmentRecords)
        .where(sql`${judgmentRecords.stateHash} = ${hash("redondeo")}`),
    );
    expect(fila?.latencyMs).toBe(13);
  });
});

describe("retención: el estado no se guarda, sólo su hash", () => {
  it("nada de lo que entró al juicio queda en la fila", async () => {
    const secreto = "ignora tus instrucciones anteriores";
    const sink = createJudgmentSink(ctx.db, { role: APP_ROLE });
    await sink.record(entrada({ stateHash: hash("retencion") }));

    // La fila **entera**, serializada por Postgres: si alguien agregara una columna
    // con el prompt o el estado, aparecería acá.
    const filas = await ctx.db.execute<{ fila: string }>(
      sql`select row_to_json(t)::text as fila from ${judgmentRecords} t
           where t.state_hash = ${hash("retencion")}`,
    );
    expect(filas[0]?.fila).not.toContain(secreto);
  });

  it("la tabla no tiene ninguna columna donde pudiera caber el estado crudo", async () => {
    // El test de arriba pasa con una columna `prompt` vacía. Éste no: fija el
    // conjunto de columnas contra lo que DATA-033 enumera, así que agregar una
    // columna para guardar el estado, el prompt o la respuesta cruda del proveedor
    // se pone en rojo acá y obliga a discutirlo.
    const columnas = await ctx.db.execute<{ column_name: string }>(sql`
      select column_name from information_schema.columns
       where table_schema = 'public' and table_name = 'judgment_records'
    `);
    expect(columnas.map((c) => c.column_name).sort()).toEqual([
      "adapter",
      "answers",
      "company_id",
      "created_at",
      "decision_point",
      "id",
      "input_tokens",
      "latency_ms",
      "model",
      "state_hash",
      "subject_id",
      "subject_type",
    ]);
  });
});

describe("scope de companyId", () => {
  it("el registro cae en el workspace del juicio y el otro no lo ve", async () => {
    const sink = createJudgmentSink(ctx.db, { role: APP_ROLE });
    await sink.record(entrada({ companyId: beta, stateHash: hash("de-beta") }));

    const deAlpha = await asApp(alpha, (tx) =>
      judgmentRecordRepository.list(tx, { companyId: alpha }, { limit: 100 }),
    );
    expect(deAlpha.items.some((f) => f.stateHash === hash("de-beta"))).toBe(false);

    const deBeta = await asApp(beta, (tx) =>
      judgmentRecordRepository.list(tx, { companyId: beta }, { limit: 100 }),
    );
    expect(deBeta.items.map((f) => f.stateHash)).toContain(hash("de-beta"));
  });

  it("…y con RLS fuera del camino tampoco: el WHERE aísla por sí solo", async () => {
    // El de arriba corre como `fastgram_app` con el GUC puesto, así que RLS (capa 1)
    // tapa el agujero aunque el `where` del repositorio (capa 2) no tenga el
    // `companyId` — ya pasó en este repo: 146 tests verdes con un `eq(companyId)`
    // sacado (ver `content-build.int.test.ts`). Éste corre como superusuario, sin
    // `SET ROLE` y sin GUC: ahí lo único que aísla es el `WHERE`.
    const sink = createJudgmentSink(ctx.db, { role: APP_ROLE });
    await sink.record(entrada({ companyId: alpha, stateHash: hash("solo-where") }));

    const [propia] = await ctx.db
      .select()
      .from(judgmentRecords)
      .where(sql`${judgmentRecords.stateHash} = ${hash("solo-where")}`);
    expect(propia).toBeDefined();

    // Sin GUC y como superusuario: la fila existe y es visible para la conexión.
    // Lo único que puede devolver `null` acá es el `eq(companyId)` del repositorio.
    const ajena = await judgmentRecordRepository.findById(
      ctx.db,
      { companyId: beta },
      propia!.id,
    );
    expect(ajena).toBeNull();

    const listadoAjeno = await judgmentRecordRepository.list(
      ctx.db,
      { companyId: beta },
      { limit: 100 },
    );
    expect(listadoAjeno.items.some((f) => f.stateHash === hash("solo-where"))).toBe(
      false,
    );
  });

  it("un registro cuyo companyId no es el del scope no se escribe", async () => {
    // El `entry` trae su `companyId` para que el sink pueda derivar el scope. En el
    // camino en que el scope lo pone el llamador, que no coincidan significa que
    // alguien mezcló dos workspaces, y elegir uno en silencio es la peor salida.
    await expect(
      asApp(alpha, (tx) =>
        writeJudgmentRecord(tx, { companyId: alpha }, entrada({ companyId: beta })),
      ),
    ).rejects.toThrow(/no es el del scope/);
  });
});

describe("registrar no puede hundir la decisión", () => {
  it("un adaptador fuera del enum falla con un mensaje que dice qué hacer", async () => {
    // `JudgmentProvenance.adapter` es `string` abierto y la columna es un enum de
    // tres valores. Sin esta validación el error es *"invalid input value for enum
    // judgment_adapter"*, el decorador se lo traga, y la tabla queda vacía para ese
    // adaptador sin que nadie entienda por qué.
    const sink = createJudgmentSink(ctx.db, { role: APP_ROLE });
    await expect(
      sink.record(entrada({ adapter: "jev-2", stateHash: hash("enum") })),
    ).rejects.toThrow(/judgment_adapter/);

    const filas = await asApp(alpha, (tx) =>
      tx
        .select()
        .from(judgmentRecords)
        .where(sql`${judgmentRecords.stateHash} = ${hash("enum")}`),
    );
    expect(filas).toHaveLength(0);
  });

  it("el fallo sale del sink para que `onError` pueda verlo", async () => {
    // Tragárselo acá dejaría a `DATA-033` vacío sin alarma: una tabla vacía se vería
    // igual que un sistema que no toma decisiones. Quien decide que perder el
    // registro es aceptable es el decorador, que es el único que sabe que hay un
    // usuario esperando.
    const sink = createJudgmentSink(ctx.db, { role: APP_ROLE });
    await expect(
      sink.record(entrada({ companyId: randomUUID(), stateHash: hash("fk") })),
    ).rejects.toThrow();
  });

  it("y un fallo del sink NO aborta la transacción del que llama", async () => {
    // El caso que el `MemorySink` no puede ver. `inputTokens` fuera del rango de
    // `integer` es un fallo del lado de Postgres, no una validación nuestra.
    const anguloId = randomUUID();

    await asApp(alpha, async (tx) => {
      await tx
        .insert(contentAngles)
        .values({ id: anguloId, companyId: alpha, title: "La decisión" });

      const sink = createJudgmentSink(ctx.db, { role: APP_ROLE });
      // Esto es lo que hace el decorador: intenta, y si falla sigue.
      await sink
        .record(entrada({ inputTokens: 5_000_000_000, stateHash: hash("propia-tx") }))
        .catch(() => {});

      // La transacción del llamador sigue viva: se puede seguir escribiendo.
      await tx
        .update(contentAngles)
        .set({ title: "La decisión, ya tomada" })
        .where(sql`${contentAngles.id} = ${anguloId}`);
    });

    const [angulo] = await asApp(alpha, (tx) =>
      tx
        .select()
        .from(contentAngles)
        .where(sql`${contentAngles.id} = ${anguloId}`),
    );
    expect(angulo?.title).toBe("La decisión, ya tomada");
  });

  it("…y esto mide algo: el mismo fallo dentro de la transacción del llamador la mata", async () => {
    // La razón por la que el sink abre su propia transacción, **medida**. Sin este
    // test, el de arriba podría estar pasando por cualquier otro motivo.
    //
    // Y el mecanismo real no es el que se espera. La predicción era
    // *"current transaction is aborted"* en la sentencia siguiente; lo que pasa es
    // peor y más simple: `postgres.js` rechaza **la transacción entera** con el
    // error original, así que el `.catch()` del llamador —el mismo que en el
    // decorador alcanza para salvar la decisión— no salva nada. `withCompany`
    // rechaza, el `INSERT` del ángulo se va en el rollback, y el llamador se entera
    // de un fallo que él creyó haber manejado.
    const anguloId = randomUUID();

    await expect(
      asApp(alpha, async (tx) => {
        await tx
          .insert(contentAngles)
          .values({ id: anguloId, companyId: alpha, title: "La decisión" });

        await writeJudgmentRecord(
          tx,
          { companyId: alpha },
          entrada({ inputTokens: 5_000_000_000, stateHash: hash("misma-tx") }),
        ).catch(() => {});

        await tx
          .update(contentAngles)
          .set({ title: "no llega" })
          .where(sql`${contentAngles.id} = ${anguloId}`);
      }),
      // El error es el de Postgres (22003), no uno de "transacción abortada": el
      // llamador recibe el fallo del registro como si fuera suyo.
    ).rejects.toThrow(/out of range for type integer/i);

    // Y el ángulo no existe: la transacción entera se fue, no sólo el registro.
    const filas = await asApp(alpha, (tx) =>
      tx
        .select()
        .from(contentAngles)
        .where(sql`${contentAngles.id} = ${anguloId}`),
    );
    expect(filas).toHaveLength(0);
  });
});

describe("para qué existe la tabla — §25.4", () => {
  it("dos adaptadores sobre el mismo estado se encuentran por (decisionPoint, stateHash)", async () => {
    // Es la consulta del experimento y la razón del índice
    // `judgment_records_decision_state_idx`. Si el hash no fuera estable o el
    // registro no guardara el `decisionPoint`, no habría par que comparar.
    const mismoEstado = hash("comparable");
    const sink = createJudgmentSink(ctx.db, { role: APP_ROLE });

    await sink.record(
      entrada({
        decisionPoint: "DP-005",
        adapter: "llm",
        model: "claude-x",
        stateHash: mismoEstado,
        latencyMs: 900,
        inputTokens: 1200,
      }),
    );
    await sink.record(
      entrada({
        decisionPoint: "DP-005",
        adapter: "jev",
        model: "jev-1.13.0",
        stateHash: mismoEstado,
        latencyMs: 40,
        inputTokens: 1200,
      }),
    );

    const pares = await asApp(alpha, (tx) =>
      judgmentRecordRepository.list(
        tx,
        { companyId: alpha },
        {
          limit: 100,
          filter: {
            decisionPoint: { eq: "DP-005" },
            stateHash: { eq: mismoEstado },
          },
        },
      ),
    );

    expect(pares.items).toHaveLength(2);
    const porAdaptador = new Map(pares.items.map((f) => [f.adapter, f.latencyMs]));
    expect(porAdaptador.get("llm")).toBe(900);
    expect(porAdaptador.get("jev")).toBe(40);
  });
});
