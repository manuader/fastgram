/**
 * El handler de `discovery-refill`, contra Postgres — `AI-002`, `P2-DISC-001`.
 *
 * ## Qué persigue este archivo
 *
 * Que la cola **se llene**. Antes de este handler nada en el repo insertaba una
 * fila en `suggestions`, así que `POST /blitz` devolvía «cola vacía» siempre.
 *
 * Y sobre todo: que **no se llene de más**. La guarda es el advisory lock por
 * workspace de `discoveryQueueStore.lockCompanyRefill`; lo que hace que la
 * segunda entrega cuente *después* de que la primera commiteó, en vez de a la
 * vez. `«dos entregas concurrentes dejan la cola en el objetivo»` es el test
 * que la mide, y está **verificado rompiéndola**: sin el lock queda rojo con
 * `expected 10 to be 5`. La nota completa del experimento está sobre ese test.
 *
 * Corre con `SET LOCAL ROLE fastgram_app`: sin el rol, la conexión de
 * desarrollo es superusuaria, saltea RLS, y el archivo mediría la mitad.
 */
import { SeededRng } from "@fastgram/adapters";
import {
  APP_ROLE,
  blitzPreferences,
  contentAngles,
  discoveryQueueStore,
  influencers,
  suggestions,
  withCompany,
  withoutCompany,
  type DbHandle,
  type QueuedSuggestionDraft,
} from "@fastgram/db";
import type { JobContext } from "@fastgram/ports";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDiscoveryRefillHandler } from "../src/discovery/refill-handler.js";
import type { BuildLogger } from "../src/content/build-handler.js";
import { openDb, seedCompany } from "./helpers/fixtures.js";

const silencioso: BuildLogger = { info: () => {}, warn: () => {}, error: () => {} };

let handle: DbHandle;

beforeAll(async () => {
  handle = openDb();
}, 120_000);

afterAll(async () => {
  await handle?.close();
});

/* ------------------------------------------------------------------------ *
 * Fixtures propias
 *
 * Van acá y no en `test/helpers/` a propósito: ese directorio es estado
 * compartido entre agentes y estas filas —ángulos, personajes, preferencias— no
 * las necesita ninguna otra suite.
 * ------------------------------------------------------------------------ */

const handler = (
  over: { seed?: number; target?: number } = {},
): ReturnType<typeof createDiscoveryRefillHandler> =>
  createDiscoveryRefillHandler({
    db: handle.db,
    rng: new SeededRng(over.seed ?? 1234),
    appRole: APP_ROLE,
    logger: silencioso,
    ...(over.target === undefined ? {} : { targetQueuedItems: over.target }),
  });

const ctx = (payload: unknown): JobContext<unknown> => ({
  jobId: `job_${randomUUID().slice(0, 8)}`,
  payload,
  attempt: 1,
  // El catálogo le da 3 intentos con backoff exponencial (§9.5.2).
  maxAttempts: 3,
});

/** Los cuatro pesos tienen que sumar 100: lo exige un CHECK de la tabla. */
interface PrefsOptions {
  readonly slideshowWeight?: number;
  readonly wallOfTextWeight?: number;
  readonly greenScreenWeight?: number;
  readonly videoHookWeight?: number;
  readonly remixPercentage?: number;
  readonly ownMediaPercentage?: number;
  readonly mentionBusinessPercentage?: number;
  readonly influencerChance?: number;
  readonly genderFilter?: "man" | "woman" | null;
  readonly angleWeights?: Record<string, number>;
  readonly textStyleWeights?: Record<string, number>;
}

async function seedPreferences(companyId: string, o: PrefsOptions = {}): Promise<void> {
  await withoutCompany(handle.db, async (tx) => {
    await tx.insert(blitzPreferences).values({
      companyId,
      slideshowWeight: o.slideshowWeight ?? 25,
      wallOfTextWeight: o.wallOfTextWeight ?? 25,
      greenScreenWeight: o.greenScreenWeight ?? 25,
      videoHookWeight: o.videoHookWeight ?? 25,
      remixPercentage: o.remixPercentage ?? 0,
      ownMediaPercentage: o.ownMediaPercentage ?? 0,
      mentionBusinessPercentage: o.mentionBusinessPercentage ?? 0,
      influencerChance: o.influencerChance ?? 0,
      genderFilter: o.genderFilter ?? null,
      angleWeights: o.angleWeights ?? {},
      textStyleWeights: o.textStyleWeights ?? {},
    });
  });
}

async function seedAngle(
  companyId: string,
  title: string,
  isActive = true,
): Promise<string> {
  return withoutCompany(handle.db, async (tx) => {
    const [row] = await tx
      .insert(contentAngles)
      .values({ companyId, title, isActive })
      .returning({ id: contentAngles.id });
    if (row === undefined) throw new Error("no se creó el ángulo");
    return row.id;
  });
}

interface InfluencerOptions {
  /** `ready` es el único estado que significa "entrenado" (`DATA-013`). */
  readonly status?:
    "generating_variations" | "training" | "ready" | "failed" | "inactive";
  readonly isActive?: boolean;
  readonly gender?: string;
}

async function seedInfluencerRow(
  companyId: string,
  name: string,
  o: InfluencerOptions = {},
): Promise<string> {
  return withoutCompany(handle.db, async (tx) => {
    const [row] = await tx
      .insert(influencers)
      .values({
        companyId,
        name,
        gender: o.gender ?? "female",
        age: 27,
        ethnicity: "latina",
        status: o.status ?? "ready",
        isActive: o.isActive ?? true,
      })
      .returning({ id: influencers.id });
    if (row === undefined) throw new Error("no se creó el influencer");
    return row.id;
  });
}

/**
 * Abre las conexiones del pool **antes** de una carrera.
 *
 * `postgres.js` conecta bajo demanda, así que sin esto la primera transacción
 * de un `Promise.all` corre y commitea mientras las demás todavía están
 * montando su socket, y lo que el test mide es `connect(2)`, no la guarda. Ver
 * la nota larga sobre el test de concurrencia: con este warm-up la misma
 * rotura pasa de verde a 15 filas.
 */
async function calentarPool(): Promise<void> {
  await Promise.all(Array.from({ length: 4 }, () => handle.sql`select pg_sleep(0.02)`));
}

/** Cinco borradores cualesquiera. Lo que se mide es cuántos entran, no qué dicen. */
function draftsDePrueba(): QueuedSuggestionDraft[] {
  return Array.from({ length: 5 }, (_, i) => ({
    contentType: "slideshow",
    aiExplanation: `borrador ${String(i)}`,
    angleId: null,
    influencerId: null,
    textStylePresetId: null,
  }));
}

/** Siembra sugerencias ya en cola, para probar el relleno parcial. */
async function seedQueued(companyId: string, howMany: number): Promise<void> {
  if (howMany === 0) return;
  await withoutCompany(handle.db, async (tx) => {
    await tx.insert(suggestions).values(
      Array.from({ length: howMany }, () => ({
        companyId,
        contentType: "slideshow" as const,
        aiExplanation: "sembrada",
      })),
    );
  });
}

interface SuggestionRow {
  readonly id: string;
  readonly content_type: string;
  readonly ai_explanation: string | null;
  readonly generated_text: string | null;
  readonly angle_id: string | null;
  readonly influencer_id: string | null;
  readonly text_style_preset_id: string | null;
  readonly remix_source_url: string | null;
  readonly source_trending_item_id: string | null;
  readonly status: string;
}

/** La cola tal como quedó. Lectura cruda: el test mira el estado real. */
async function readQueue(companyId: string): Promise<SuggestionRow[]> {
  const filas = await handle.sql`
    select id, content_type, ai_explanation, generated_text, angle_id, influencer_id,
           text_style_preset_id, remix_source_url, source_trending_item_id, status
      from suggestions
     where company_id = ${companyId}::uuid
     order by created_at, id
  `;
  return filas as unknown as SuggestionRow[];
}

/* ------------------------------------------------------------------------ *
 * El camino feliz
 * ------------------------------------------------------------------------ */

describe("el relleno", () => {
  it("lleva una cola vacía hasta el objetivo", async () => {
    const companyId = await seedCompany(handle);
    await seedPreferences(companyId);

    await handler()(ctx({ companyId }));

    const cola = await readQueue(companyId);
    expect(cola).toHaveLength(5);
    expect(cola.every((s) => s.status === "queued")).toBe(true);
    expect(
      cola.every((s) =>
        ["slideshow", "wall-of-text", "green-screen", "video-hook"].includes(
          s.content_type,
        ),
      ),
    ).toBe(true);
  });

  it("con 3 en cola inserta exactamente 2", async () => {
    const companyId = await seedCompany(handle);
    await seedPreferences(companyId);
    await seedQueued(companyId, 3);

    await handler()(ctx({ companyId }));

    expect(await readQueue(companyId)).toHaveLength(5);
  });

  it("con la cola llena no inserta nada", async () => {
    const companyId = await seedCompany(handle);
    await seedPreferences(companyId);
    await seedQueued(companyId, 5);

    await handler()(ctx({ companyId }));

    const cola = await readQueue(companyId);
    expect(cola).toHaveLength(5);
    expect(cola.every((s) => s.ai_explanation === "sembrada")).toBe(true);
  });

  it("las `popped` y las `discarded` no cuentan como cola", async () => {
    // El índice parcial de `DATA-007` es sobre `queued`, y la cola que el
    // usuario ve es ésa. Contar las ya consumidas dejaría al workspace sin
    // relleno para siempre después de cinco swipes.
    const companyId = await seedCompany(handle);
    await seedPreferences(companyId);
    await seedQueued(companyId, 5);
    await handle.sql`
      update suggestions set status = 'popped' where company_id = ${companyId}::uuid
    `;

    await handler()(ctx({ companyId }));

    const cola = await readQueue(companyId);
    expect(cola).toHaveLength(10);
    expect(cola.filter((s) => s.status === "queued")).toHaveLength(5);
  });

  it("un workspace sin fila de preferencias también se llena", async () => {
    // `DATA-006`: *"sintetiza defaults si no existe fila"*. Es justo el
    // workspace recién creado —el que más necesita no tener la cola vacía— el
    // que todavía no tiene fila.
    const companyId = await seedCompany(handle);
    await seedAngle(companyId, "Growth hacks");

    await handler()(ctx({ companyId }));

    const cola = await readQueue(companyId);
    expect(cola).toHaveLength(5);
    // Sin fila, `angleWeights` se sintetiza con `reconcileAngleWeights`, así
    // que el único ángulo activo tiene que salir en todas.
    expect(cola.every((s) => s.angle_id !== null)).toBe(true);
  });
});

/* ------------------------------------------------------------------------ *
 * Idempotencia — la parte que no se puede romper
 * ------------------------------------------------------------------------ */

describe("idempotencia bajo reentrega", () => {
  it("una segunda entrega del mismo job no agrega nada", async () => {
    const companyId = await seedCompany(handle);
    await seedPreferences(companyId);
    const job = ctx({ companyId });

    await handler()(job);
    await handler()(job);

    expect(await readQueue(companyId)).toHaveLength(5);
  });

  it("tres entregas concurrentes dejan la cola en el objetivo, no en el triple", async () => {
    // **La primera versión de este test era mentira, y lo comprobé.**
    //
    // Sin `calentarPool()`, con el advisory lock quitado, seguía verde. El
    // motivo no era el lock ni la sentencia: era que las tres entregas **no se
    // solapaban**. `postgres.js` abre las conexiones bajo demanda, así que la
    // primera entrega reutilizaba la ya abierta y las otras dos se quedaban
    // ~8 ms montando su TCP. Medido con una sonda que imprime cuándo abre cada
    // transacción:
    //
    //     A tx abierta  +2ms
    //     A insertó 5, veía 0  +7ms      ← A ya commiteó
    //     C tx abierta  +10ms            ← C recién empieza
    //     B tx abierta  +11ms
    //     TOTAL EN COLA: 5               ← verde, sin guarda
    //
    // Con el pool caliente, la misma sonda y la misma rotura:
    //
    //     A insertó 5, veía 0  +9ms
    //     C insertó 5, veía 0  +9ms
    //     B insertó 5, veía 0  +9ms
    //     TOTAL EN COLA: 15
    //
    // O sea: el `warm-up` no es ceremonia, es lo que convierte a este test en
    // una medición. Sin él mide la latencia de `connect(2)`.
    //
    // Aun así, este test depende de que tres promesas se solapen, y eso es
    // timing. La misma propiedad **sin timing** está en
    // `«una entrega que ve la cola a medio escribir espera, no duplica»`, que
    // sostiene una transacción abierta a mano.
    await calentarPool();
    const companyId = await seedCompany(handle);
    await seedPreferences(companyId);
    const job = ctx({ companyId });

    await Promise.all([handler()(job), handler()(job), handler()(job)]);

    expect(await readQueue(companyId)).toHaveLength(5);
  });

  it("una entrega que ve la cola a medio escribir espera, no duplica", async () => {
    // **El test que mide la guarda sin depender de ningún timing.**
    //
    // `A` toma el lock, inserta y **se queda con la transacción abierta**. `B`
    // llega después: con el lock, se bloquea y no puede ni contar; sin el lock,
    // cuenta 0 —las filas de `A` todavía no commitearon, y READ COMMITTED no
    // las ve— e inserta otras cinco.
    //
    // La carrera no es probabilística: `B` sólo puede terminar antes de que `A`
    // suelte si el lock no está. Por eso se espera a `B` contra un temporizador
    // en vez de a secas: si `B` termina, es que la guarda no está.
    //
    // Verificado rompiéndolo, en las dos formas posibles:
    //  - `lockCompanyRefill` vaciada, sentencia atómica intacta → **rojo**,
    //    `expected 10 to be 5`. Es la prueba de que un `INSERT` no bloquea
    //    contra nada y de que la sentencia sola no alcanza — al revés que
    //    `claimCreditsRefund`, que es un `UPDATE` y sí se sostiene sola.
    //  - `refillQueue` reemplazada por `SELECT count(*)` y después `INSERT`,
    //    con el lock puesto → **verde**, porque lo que serializa es el lock.
    //    Está dicho acá para que nadie lea la sentencia atómica como la guarda:
    //    lo que aporta es que el conteo y la inserción no se puedan escribir en
    //    transacciones distintas, no aislamiento.
    const companyId = await seedCompany(handle);
    await seedPreferences(companyId);
    const scope = { companyId };

    let soltarA = (): void => {};
    const retenido = new Promise<void>((resolve) => {
      soltarA = resolve;
    });
    let aInsertó = (): void => {};
    const aYaInsertó = new Promise<void>((resolve) => {
      aInsertó = resolve;
    });

    const a = withCompany(
      handle.db,
      companyId,
      async (tx) => {
        await discoveryQueueStore.lockCompanyRefill(tx, scope);
        const r = await discoveryQueueStore.refillQueue(tx, scope, 5, draftsDePrueba());
        aInsertó();
        // La transacción sigue abierta acá: es el punto del test.
        await retenido;
        return r;
      },
      { role: APP_ROLE },
    );

    await aYaInsertó;

    const b = withCompany(
      handle.db,
      companyId,
      async (tx) => {
        await discoveryQueueStore.lockCompanyRefill(tx, scope);
        return discoveryQueueStore.refillQueue(tx, scope, 5, draftsDePrueba());
      },
      { role: APP_ROLE },
    );

    // Si `b` termina acá, es que no se bloqueó, o sea que no hay guarda.
    const marca = Symbol("sigue bloqueada");
    const quienGanó = await Promise.race([
      b.then(() => "b" as const),
      new Promise<typeof marca>((resolve) => setTimeout(() => resolve(marca), 300)),
    ]);
    soltarA();

    const [resA, resB] = await Promise.all([a, b]);

    expect(quienGanó).toBe(marca);
    expect(resA.insertedIds).toHaveLength(5);
    expect(resB.insertedIds).toHaveLength(0);
    expect(await readQueue(companyId)).toHaveLength(5);
  });

  it("dos workspaces distintos no se esperan entre sí", async () => {
    // El lock es por workspace. Si alguien lo cambiara por uno global —o por
    // una clave constante— esto seguiría verde, pero la cabecera del
    // repositorio dejaría de ser cierta y el refill se volvería un cuello
    // global. Lo que este test sí garantiza es que los dos terminan.
    const a = await seedCompany(handle);
    const b = await seedCompany(handle);
    await seedPreferences(a);
    await seedPreferences(b);

    await Promise.all([
      handler()(ctx({ companyId: a })),
      handler()(ctx({ companyId: b })),
    ]);

    expect(await readQueue(a)).toHaveLength(5);
    expect(await readQueue(b)).toHaveLength(5);
  });

  it("el workspace ajeno no se toca", async () => {
    const mio = await seedCompany(handle);
    const ajeno = await seedCompany(handle);
    await seedPreferences(mio);
    await seedPreferences(ajeno);

    await handler()(ctx({ companyId: mio }));

    expect(await readQueue(ajeno)).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------ *
 * Lo que se guarda en la fila
 * ------------------------------------------------------------------------ */

describe("la fila guardada", () => {
  it("persiste `aiExplanation` con la sugerencia", async () => {
    // `P2-DISC-005`: la explicación se almacena, **no** se regenera al abrir.
    const companyId = await seedCompany(handle);
    await seedPreferences(companyId, {
      greenScreenWeight: 100,
      slideshowWeight: 0,
      wallOfTextWeight: 0,
      videoHookWeight: 0,
    });

    await handler()(ctx({ companyId }));

    const cola = await readQueue(companyId);
    expect(cola).toHaveLength(5);
    for (const fila of cola) {
      expect(fila.ai_explanation).toBeTruthy();
      expect(fila.ai_explanation).toContain("Format: green-screen");
      // `FR-055` regla 5: `green-screen` nunca usa influencer, y la explicación
      // lo dice con su motivo en vez de callarlo.
      expect(fila.ai_explanation).toContain("green-screen is always regular content");
    }
  });

  it("el título del ángulo entra en la explicación, y el id en la columna", async () => {
    const companyId = await seedCompany(handle);
    const angleId = await seedAngle(companyId, "Growth hacks para fundadores");
    await seedPreferences(companyId, { angleWeights: { [angleId]: 100 } });

    await handler()(ctx({ companyId }));

    const cola = await readQueue(companyId);
    expect(cola.every((s) => s.angle_id === angleId)).toBe(true);
    expect(cola[0]?.ai_explanation).toContain("Growth hacks para fundadores");
  });

  it("un ángulo inactivo no compite", async () => {
    const companyId = await seedCompany(handle);
    const activo = await seedAngle(companyId, "El bueno");
    await seedAngle(companyId, "El apagado", false);
    await seedPreferences(companyId, { angleWeights: { [activo]: 100 } });

    await handler()(ctx({ companyId }));

    expect((await readQueue(companyId)).every((s) => s.angle_id === activo)).toBe(true);
  });

  it("con un único personaje elegible, se persiste su id", async () => {
    // Con un candidato no hay juicio que emitir: cualquier procedimiento de
    // `DP-005`/`JV-6` devuelve el mismo. Con varios sí lo hay, y ese caso es el
    // de abajo.
    const companyId = await seedCompany(handle);
    const influencerId = await seedInfluencerRow(companyId, "Vera");
    await seedPreferences(companyId, {
      influencerChance: 100,
      // `green-screen` nunca lleva personaje: se saca del mix para que la
      // aserción no dependa de qué formato salió.
      slideshowWeight: 50,
      wallOfTextWeight: 50,
      greenScreenWeight: 0,
      videoHookWeight: 0,
    });

    await handler()(ctx({ companyId }));

    const cola = await readQueue(companyId);
    expect(cola.every((s) => s.influencer_id === influencerId)).toBe(true);
    expect(cola[0]?.ai_explanation).toContain("Influencer: Vera");
  });

  it("con varios candidatos no se elige con un dado: queda null y se explica", async () => {
    // `DP-005`/`JV-6` (PRD §25) ordena candidatos por encaje con la marca, y no
    // hay adaptador de `Judgment` para ese punto de decisión. Resolverlo con
    // `rng` sería sustituir un juicio semántico por azar — lo que `EXT-008`
    // existe para evitar, y lo que `plan-suggestion.ts` prohíbe por escrito.
    const companyId = await seedCompany(handle);
    await seedInfluencerRow(companyId, "Vera");
    await seedInfluencerRow(companyId, "Nara");
    await seedPreferences(companyId, {
      influencerChance: 100,
      slideshowWeight: 50,
      wallOfTextWeight: 50,
      greenScreenWeight: 0,
      videoHookWeight: 0,
    });

    await handler()(ctx({ companyId }));

    const cola = await readQueue(companyId);
    expect(cola.every((s) => s.influencer_id === null)).toBe(true);
    expect(cola[0]?.ai_explanation).toContain("not available yet");
  });

  it("un personaje sin entrenar no es candidato", async () => {
    const companyId = await seedCompany(handle);
    await seedInfluencerRow(companyId, "A medio hacer", { status: "training" });
    await seedPreferences(companyId, {
      influencerChance: 100,
      slideshowWeight: 100,
      wallOfTextWeight: 0,
      greenScreenWeight: 0,
      videoHookWeight: 0,
    });

    await handler()(ctx({ companyId }));

    const cola = await readQueue(companyId);
    expect(cola.every((s) => s.influencer_id === null)).toBe(true);
    // `FR-055` regla 3: sin elegible **se cae a contenido regular**, no es un
    // error. El personaje puede estar entrenando (15–20 min).
    expect(cola[0]?.ai_explanation).toContain("no active, trained character fits");
  });

  it("el preset de caption se persiste cuando hay mix", async () => {
    const companyId = await seedCompany(handle);
    await seedPreferences(companyId, { textStyleWeights: { "bold-impact": 100 } });

    await handler()(ctx({ companyId }));

    const cola = await readQueue(companyId);
    expect(cola.every((s) => s.text_style_preset_id === "bold-impact")).toBe(true);
  });

  it("no inventa copy ni fuente de remix", async () => {
    // Las dos columnas quedan `null` a propósito: `generatedText` es un LLM con
    // un prompt que todavía no existe, y *qué* remixar es `DP-005`/`JV-6`.
    // Rellenarlas con texto de relleno se le mostraría al usuario como si fuera
    // la propuesta real.
    const companyId = await seedCompany(handle);
    await seedPreferences(companyId, { remixPercentage: 100 });

    await handler()(ctx({ companyId }));

    const cola = await readQueue(companyId);
    expect(cola.every((s) => s.generated_text === null)).toBe(true);
    expect(cola.every((s) => s.remix_source_url === null)).toBe(true);
    expect(cola.every((s) => s.source_trending_item_id === null)).toBe(true);
    expect(cola[0]?.ai_explanation).toContain("Source: a remix of trending content");
  });
});

/* ------------------------------------------------------------------------ *
 * Determinismo
 * ------------------------------------------------------------------------ */

describe("determinismo", () => {
  it("el mismo seed sobre el mismo estado produce el mismo conjunto de filas", async () => {
    // Es lo que permite reproducir una sugerencia rara que reportó un usuario.
    // Se comprueba hasta la **fila guardada**, no sólo hasta el plan: la
    // explicación también tiene que ser determinista o el determinismo se corta
    // justo antes de lo que el usuario ve.
    //
    // **El conjunto, no la secuencia, y no es pereza del test.** Las cinco
    // filas de un refill entran en una sola sentencia, así que comparten
    // `created_at` al microsegundo —es el reloj de la transacción, no el de la
    // fila— y el orden de la cola, que es `(created_at, id)`, lo termina
    // decidiendo un uuid aleatorio. Lo descubrí acá: la primera versión de este
    // test comparaba secuencias y salía roja con las cinco sugerencias
    // idénticas en distinto orden.
    //
    // Se deja así en vez de escalonar los timestamps porque el orden **dentro**
    // de un lote no significa nada: las cinco son tiradas independientes
    // (`FR-055`, `influencerChance` no es una cuota de lote). Queda reportado
    // igual, porque quien lea `POST /blitz` esperando FIFO estricto dentro de
    // un refill va a encontrarse con otra cosa.
    const a = await seedCompany(handle);
    const b = await seedCompany(handle);
    await seedPreferences(a, {
      influencerChance: 50,
      textStyleWeights: {
        "bold-impact": 50,
        snapchat: 50,
      },
    });
    await seedPreferences(b, {
      influencerChance: 50,
      textStyleWeights: {
        "bold-impact": 50,
        snapchat: 50,
      },
    });

    await handler({ seed: 99 })(ctx({ companyId: a }));
    await handler({ seed: 99 })(ctx({ companyId: b }));

    const huella = (rows: SuggestionRow[]) =>
      rows
        .map((r) => `${r.content_type}|${r.text_style_preset_id}|${r.ai_explanation}`)
        .sort();

    expect(huella(await readQueue(a))).toEqual(huella(await readQueue(b)));
  });
});

/* ------------------------------------------------------------------------ *
 * Lo que no debe explotar
 * ------------------------------------------------------------------------ */

describe("payloads y estados que no son de este mundo", () => {
  it("un payload sin `companyId` se descarta sin relanzar", async () => {
    await expect(handler()(ctx({}))).resolves.toBeUndefined();
  });

  it("un payload que no es un objeto se descarta sin relanzar", async () => {
    await expect(handler()(ctx("nope"))).resolves.toBeUndefined();
  });

  it("un `companyId` que no es un UUID se descarta sin relanzar", async () => {
    // Sin la comprobación del parser esto llega a `withCompany`, que **lanza**,
    // y la cola lo reintenta tres veces antes de mandarlo a la dead-letter
    // como si fuera un fallo de infraestructura. Es un bug del productor.
    await expect(
      handler()(ctx({ companyId: "no-soy-un-uuid" })),
    ).resolves.toBeUndefined();
  });

  it("pesos de ángulo que no cubren a ningún activo: no inserta y no relanza", async () => {
    // `plan-suggestion.ts` grita `invalid_state` a propósito: un mapa que no
    // cubre a los activos es un bug de la transacción de reconcile (§9.4), y
    // repartir a ojo lo escondería para siempre. Lo que este handler agrega es
    // que **no reintenta**: tres intentos dan el mismo error y ensucian la
    // dead-letter con algo que no es un fallo de infraestructura.
    const companyId = await seedCompany(handle);
    await seedAngle(companyId, "Sin peso");
    await seedPreferences(companyId, { angleWeights: {} });

    await expect(handler()(ctx({ companyId }))).resolves.toBeUndefined();
    expect(await readQueue(companyId)).toHaveLength(0);
  });
});
