/**
 * El lado de la base del relleno de la discovery queue — `P2-DISC-001`,
 * `AI-002`, PRD §9.5.2.
 *
 * ## Por qué vive acá y no en `apps/worker`
 *
 * Por lo mismo que `content-build.ts` y `influencer-credits.ts`: esto es SQL, y
 * `apps/worker` **no puede importar `drizzle-orm`**. No es alcanzable a
 * propósito — es lo que impide que un proceso arme su propio `WHERE` y se
 * olvide el tenant.
 *
 * ## El problema, que no es el mismo que el del reembolso
 *
 * `influencerCreditsStore.claimCreditsRefund` cierra su carrera con **una sola
 * sentencia**, y funciona porque es un `UPDATE`: con READ COMMITTED, dos
 * `UPDATE` sobre la misma fila no corren a la vez —el segundo espera y
 * **reevalúa** su `WHERE`— así que el segundo se va con las manos vacías.
 *
 * Acá el trabajo es un `INSERT`, y **un `INSERT` no bloquea contra nada**. Dos
 * entregas concurrentes del refill toman cada una su snapshot, las dos cuentan
 * 0 en cola, las dos insertan 5, y la cola queda en 10. Escribirlo como una
 * sola sentencia no lo arregla: el conteo y la inserción quedan atómicos entre
 * sí, pero la otra transacción sigue sin verse. Lo que cierra esa carrera en un
 * `INSERT` es o un índice único —que `suggestions` no tiene, y que no puede
 * tener: la cola admite N filas iguales— o un lock que las dos entregas
 * disputen.
 *
 * Por eso hay **dos piezas y no una**, y conviene saber cuál sostiene qué:
 *
 *  1. {@link lockCompanyRefill} — **es la guarda**. Un advisory lock de
 *     transacción por workspace. Es lo que hace que la segunda entrega cuente
 *     *después* de que la primera commiteó, en vez de a la vez.
 *  2. {@link refillQueue} — **cuenta e inserta en una sola sentencia**. Con el
 *     lock tomado, esto no agrega aislamiento; lo que agrega es que el conteo y
 *     la inserción **no se puedan escribir en dos transacciones distintas** por
 *     descuido. Es la diferencia entre una invariante y una convención.
 *
 * Decirlo al revés —«la sentencia atómica es la guarda»— sería repetir la
 * trampa 24 del handoff: un test de doble reembolso que seguía verde con la
 * guarda quitada, porque lo que serializaba era un lock que estaba más arriba.
 * Acá el lock **está** más arriba y está puesto a propósito; lo que no se puede
 * es fingir que la sentencia sola alcanzaría.
 *
 * ## Por qué un advisory lock y no una fila
 *
 * Lo natural sería `SELECT … FOR UPDATE` sobre `blitz_preferences`, que es 1:1
 * con la company. No sirve: `DATA-006` dice *"sintetiza defaults si no existe
 * fila"*, así que justo el workspace recién creado —el que más necesita que le
 * llenen la cola— no tiene fila que bloquear, y `FOR UPDATE` sobre cero filas
 * no bloquea nada. Bloquear `companies` serializaría el refill contra cualquier
 * otro escritor de esa tabla, que es mucho más de lo que hace falta.
 *
 * El advisory lock no necesita que exista ninguna fila, se libera solo al
 * terminar la transacción (`_xact_`, nunca `pg_advisory_lock` a secas: ése
 * sobrevive al commit y con un pool se queda tomado por la conexión), y su
 * clave sale del `companyId`, así que dos workspaces nunca se esperan.
 *
 * ## Lo que esto NO promete
 *
 * `AI-002` dice que *"refills concurrentes pueden excederla transitoriamente"*
 * y el catálogo del worker no serializa la cola a propósito. El lock de acá es
 * **por workspace y por transacción de escritura**, que dura milisegundos: dos
 * refills del mismo workspace se ordenan, dos de workspaces distintos no se
 * tocan. Que en la práctica la cola no se exceda es más fuerte que lo que el
 * PRD pide, no menos, y no cuesta nada — el trabajo lento (planificar) pasa
 * fuera de la transacción.
 */

import { and, eq, sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import { suggestions } from "../schema/blitz.js";
import type { TenantScope } from "./base.js";

/**
 * Una sugerencia lista para guardar.
 *
 * Es lo que el planificador decidió, ya traducido a columnas. No hay
 * `companyId`: lo pone el scope, igual que en `createCompanyScopedRepository`,
 * y que no esté en el tipo es lo que hace imposible —no sólo desaconsejable—
 * escribir en otro workspace.
 */
export interface QueuedSuggestionDraft {
  /** Uno de `suggestion_content_type`. `custom` no sale de la cola (`FR-050`). */
  readonly contentType: string;
  /** `AI-002` / `P2-DISC-005`: se persiste con la fila, no se regenera al abrir. */
  readonly aiExplanation: string;
  readonly angleId: string | null;
  readonly influencerId: string | null;
  readonly textStylePresetId: string | null;
  /** `AI-002`: la copy, generada al planificar y guardada con la fila. */
  readonly generatedText: string | null;
  /**
   * `suggestions.build_plan` (migración `0011`): el `SuggestionBuildPlan` de
   * `core`. Se guarda tal cual; quien lo lee lo valida con
   * `parseSuggestionBuildPlan`.
   */
  readonly buildPlan: unknown;
}

export interface RefillResult {
  /**
   * Cuántas había en cola **en el snapshot de la sentencia**, o sea el número
   * que decidió cuántas entraron. No es una lectura aparte: sale del mismo
   * `WITH`, así que no puede estar desalineado con lo que se insertó.
   */
  readonly queuedBefore: number;
  /**
   * Ids de las que entraron. Vacío es un resultado normal: la cola ya estaba
   * llena. **Sin orden garantizado**: `RETURNING` sólo ve columnas de la fila
   * insertada, así que no hay por dónde arrastrar el `ord` del borrador. Sirven
   * para contar y para el log, no para correlacionar con la entrada.
   */
  readonly insertedIds: readonly string[];
}

/**
 * La clave del advisory lock, derivada del `companyId`.
 *
 * Se calcula en JS y no con `hashtext()` para no depender de una función
 * interna de Postgres cuya estabilidad entre versiones no está documentada. Los
 * primeros 64 bits del UUID alcanzan y sobran: una colisión no rompe nada, sólo
 * haría que dos workspaces se esperen unos milisegundos.
 *
 * Vuelve como **string** porque un `bigint` de 64 bits no entra en un `number`
 * de JS sin perder bits, y un parámetro que pierde bits es una clave distinta.
 */
export function refillLockKey(companyId: string): string {
  const hex = companyId.replace(/-/gu, "").slice(0, 16);
  if (hex.length !== 16 || !/^[0-9a-f]{16}$/iu.test(hex)) {
    throw new Error(
      `companyId inválido para derivar la clave del lock: ${JSON.stringify(companyId)}. ` +
        "Se espera un UUID; `withCompany` ya lo exige, así que llegar acá con otra " +
        "cosa significa que alguien llamó al repositorio fuera de scope.",
    );
  }
  // `asIntN` porque `pg_advisory_xact_lock` toma un bigint **con signo**: sin
  // esto, cualquier UUID cuyo primer bit sea 1 se sale del rango y Postgres
  // rechaza la llamada con un error de casteo, no con un deadlock.
  return BigInt.asIntN(64, BigInt(`0x${hex}`)).toString();
}

/**
 * Toma el lock del refill de este workspace hasta el fin de la transacción.
 *
 * Quien llame **tiene que estar dentro de una transacción**: fuera de una,
 * `pg_advisory_xact_lock` se libera al terminar la sentencia y no protege nada.
 * El `Executor` no distingue una cosa de la otra, así que queda escrito.
 *
 * Bloquea —no es `try_`— a propósito: una entrega que no consigue el lock no
 * tiene nada mejor que hacer que esperar unos milisegundos y volver a contar.
 * Rendirse la dejaría sin insertar cuando la cola sí tenía hueco.
 */
export async function lockCompanyRefill(
  exec: Executor,
  scope: TenantScope,
): Promise<void> {
  await exec.execute(
    sql`select pg_advisory_xact_lock(${refillLockKey(scope.companyId)}::bigint)`,
  );
}

interface RawRefillRow {
  readonly queued_before: number | string;
  readonly ids: readonly string[] | null;
}

/**
 * Lleva la cola hasta `target`, insertando **como mucho** los borradores que se
 * le den, y **exactamente** los que falten.
 *
 * Una sola sentencia. El `WITH` fija un snapshot: `queued` cuenta lo que hay,
 * `inserted` inserta los primeros `target - queued` borradores, y la salida
 * reporta las dos cosas. No hay forma de que el número que decidió y el número
 * que entró se hayan mirado en momentos distintos.
 *
 * Los borradores viajan como **un `jsonb`** y no como cinco arrays paralelos:
 * cinco arrays se desalinean en silencio si alguien agrega una columna y se
 * olvida de uno, y el `NULL` dentro de un `uuid[]` es justo donde el driver se
 * pone creativo. El `ord` va **explícito dentro de cada objeto** en vez de
 * confiar en el orden de `jsonb_to_recordset`, que en la práctica se respeta
 * pero no está prometido.
 *
 * **No toma el lock por su cuenta**: ver {@link lockCompanyRefill} y la cabecera
 * del archivo. Llamarla sin lock sigue siendo correcto para una sola entrega, y
 * deja de serlo en cuanto hay dos.
 */
export async function refillQueue(
  exec: Executor,
  scope: TenantScope,
  target: number,
  drafts: readonly QueuedSuggestionDraft[],
): Promise<RefillResult> {
  if (!Number.isInteger(target) || target < 0) {
    throw new Error(`target tiene que ser un entero >= 0, llegó ${String(target)}.`);
  }

  const payload = JSON.stringify(
    drafts.map((draft, index) => ({
      ord: index + 1,
      content_type: draft.contentType,
      ai_explanation: draft.aiExplanation,
      angle_id: draft.angleId,
      influencer_id: draft.influencerId,
      text_style_preset_id: draft.textStylePresetId,
      generated_text: draft.generatedText,
      build_plan: draft.buildPlan ?? null,
    })),
  );

  const filas = await exec.execute(sql`
    with drafts as (
      select *
        from jsonb_to_recordset(${payload}::jsonb)
          as d(ord int, content_type text, ai_explanation text,
               angle_id uuid, influencer_id uuid, text_style_preset_id text,
               generated_text text, build_plan jsonb)
    ),
    queued as (
      select count(*)::int as n
        from suggestions
       where company_id = ${scope.companyId}::uuid
         and status = 'queued'
    ),
    inserted as (
      insert into suggestions
        (company_id, content_type, ai_explanation, angle_id, influencer_id,
         text_style_preset_id, generated_text, build_plan, status)
      select ${scope.companyId}::uuid,
             drafts.content_type::suggestion_content_type,
             drafts.ai_explanation,
             drafts.angle_id,
             drafts.influencer_id,
             drafts.text_style_preset_id,
             drafts.generated_text,
             drafts.build_plan,
             'queued'::suggestion_status
        from drafts cross join queued
       where drafts.ord <= greatest(0, ${target}::int - queued.n)
      returning id
    )
    select (select n from queued) as queued_before,
           coalesce(array_agg(inserted.id::text), '{}'::text[]) as ids
      from inserted
  `);

  const fila = (filas as unknown as RawRefillRow[])[0];
  if (fila === undefined) {
    // El `WITH` termina en un agregado sin `GROUP BY`, así que devuelve una
    // fila aunque no se inserte nada. Llegar acá significa que alguien cambió
    // la forma de la consulta y rompió esa propiedad.
    throw new Error("El refill no devolvió su fila de resumen.");
  }

  return {
    queuedBefore: Number(fila.queued_before),
    insertedIds: fila.ids ?? [],
  };
}

/**
 * Cuántas hay en cola. **Informativa**: no decide cuántas insertar.
 *
 * Quien decide es la subconsulta de {@link refillQueue}, que corre en la misma
 * sentencia que el `INSERT`. Ésta sirve para el log y para saltearse el trabajo
 * de planificar cuando la cola ya está llena — un atajo, nunca una guarda.
 */
export async function countQueued(exec: Executor, scope: TenantScope): Promise<number> {
  const filas = await exec
    .select({ value: sql<number>`count(*)::int` })
    .from(suggestions)
    .where(
      and(eq(suggestions.companyId, scope.companyId), eq(suggestions.status, "queued")),
    );
  return filas[0]?.value ?? 0;
}

/** Un asset del Media Bank que puede entrar en una pieza. Forma de `PlanningMedia` de `core`. */
export interface PlanningMediaRow {
  readonly id: string;
  readonly mediaType: "image" | "video";
  readonly url: string;
  readonly categories: readonly string[];
}

/** Un set con influencer (`DATA-011`), para los pools de `FR-083`. */
export interface InfluencerSetRow {
  readonly influencerId: string;
  readonly kind: "SLIDESHOW" | "VIDEO" | "CURATED";
  readonly mediaIds: readonly string[];
}

/**
 * Lo que el planificador puede usar del Media Bank — `AI-002` («Media Bank del
 * workspace»), `FR-100`, `FR-083`.
 *
 * - **Sólo `ready` y no borrada.** Un video `processing` todavía no está
 *   normalizado (`FR-100`: MOV→MP4, faststart) y el motor de render podría no
 *   leerlo; uno `failed` no se va a poder leer nunca.
 * - **Con alguna categoría, o en un set de influencer.** `FR-100`: «lista
 *   vacía = el asset sale de todos los pools automáticos de Blitz». Los de un
 *   set de influencer entran igual: el set es la elección explícita.
 * - **Orden estable** (`created_at, media_id`): con un `Rng` sembrado, el mismo
 *   estado tiene que dar la misma media. Sin `ORDER BY` el orden lo decide el
 *   plan de ejecución.
 *
 * Sin tope de filas: el Media Bank ya está acotado por la cuota de storage, y
 * un tope acá haría que la media más vieja deje de salir sin que nadie lo sepa.
 */
export async function listPlanningMedia(
  exec: Executor,
  scope: TenantScope,
): Promise<{
  readonly media: readonly PlanningMediaRow[];
  readonly influencerSets: readonly InfluencerSetRow[];
}> {
  const sets = (await exec.execute(sql`
    select influencer_id::text as influencer_id, kind::text as kind,
           coalesce(media_ids::text[], '{}'::text[]) as media_ids
      from media_sets
     where company_id = ${scope.companyId}::uuid
       and influencer_id is not null
     order by created_at, id
  `)) as unknown as {
    influencer_id: string;
    kind: InfluencerSetRow["kind"];
    media_ids: string[];
  }[];

  const media = (await exec.execute(sql`
    select m.media_id::text as id, m.media_type::text as media_type,
           m.r2_url as url, m.categories
      from media m
     where m.company_id = ${scope.companyId}::uuid
       and m.deleted_at is null
       and m.status = 'ready'
       and (
         cardinality(m.categories) > 0
         or exists (
           select 1 from media_sets s
            where s.company_id = m.company_id
              and s.influencer_id is not null
              and m.media_id = any(s.media_ids)
         )
       )
     order by m.created_at, m.media_id
  `)) as unknown as {
    id: string;
    media_type: "image" | "video";
    url: string;
    categories: string[] | null;
  }[];

  return {
    media: media.map((r) => ({
      id: r.id,
      mediaType: r.media_type,
      url: r.url,
      categories: r.categories ?? [],
    })),
    influencerSets: sets.map((r) => ({
      influencerId: r.influencer_id,
      kind: r.kind,
      mediaIds: r.media_ids,
    })),
  };
}

export const discoveryQueueStore = {
  table: suggestions,
  lockCompanyRefill,
  refillQueue,
  countQueued,
  refillLockKey,
  listPlanningMedia,
};
