/**
 * `DATA-033` contra Postgres — `P1-JUDGE-005`, PRD §9.15 y §25.4.
 *
 * ## Qué faltaba
 *
 * `RecordingJudgment` (`packages/adapters/src/judgment/recording-judgment.ts`)
 * escribe contra una interfaz `JudgmentSink`, y el único `implements JudgmentSink`
 * del repo era el `MemorySink` de su propio test. O sea: el decorador estaba
 * entero, la tabla estaba entera, y entre los dos no había nada. Esto es ese
 * pedazo.
 *
 * ## Por qué el tipo de entrada se vuelve a declarar acá en vez de importarse
 *
 * Porque los dos paquetes **no se conocen, y es a propósito**: `packages/db` no
 * depende de `packages/adapters` ni al revés (ninguno de los dos `package.json`
 * nombra al otro, y `packages/db/tsconfig.json` no hereda los `paths` de la raíz,
 * así que el import ni siquiera resolvería). El puente es estructural: TypeScript
 * no pide nominalidad, así que `DbJudgmentSink` entra donde se espera un
 * `JudgmentSink` con sólo tener la misma forma.
 *
 * ## Qué NO protege ese puente — medido, porque la intuición se equivoca
 *
 * La respuesta cómoda sería "si los tipos divergen, el montaje no compila". **Es
 * falsa, y se midió.** Compilando un montaje real de las dos piezas contra los
 * `paths` de `tsconfig.base.json`:
 *
 *  - agregarle a `JudgmentRecordInput` un campo requerido que `JudgmentRecordEntry`
 *    no tiene (se probó con un `promptCrudo: string`) → **compila igual**, exit 0.
 *    Los métodos son bivariantes en TypeScript, así que alcanza con que una de las
 *    dos direcciones sea asignable, y siempre lo es;
 *  - cambiarle el tipo a un campo que los dos tienen (`latencyMs: number` →
 *    `string`) → **sí falla**, `TS2345`.
 *
 * O sea: el montaje detecta un tipo incompatible y **no** detecta un campo de más
 * ni uno de menos. Un campo nuevo en el decorador llega acá como `undefined` y se
 * pierde sin que nada avise. Lo único que lo agarra es un test de este lado que
 * afirme la fila completa —`judgment-sink.int.test.ts`, *"con el sujeto, la
 * procedencia, las respuestas y las dos métricas"*— y la lista de columnas de la
 * tabla. Quien agregue un campo a `DATA-033` tiene que tocar los dos paquetes a
 * mano; no hay red.
 *
 * ## Las tres decisiones que importan
 *
 * 1. **El sink abre su propia transacción, no la del que llama.** Ésta es la que
 *    no es obvia. El decorador ya envuelve `record()` en un `catch`, así que un
 *    fallo de escritura no voltea la decisión… *siempre que el fallo se quede
 *    adentro del sink*. Si el `INSERT` corriera en la transacción del llamador,
 *    un error —un `inputTokens` fuera del rango de `integer`, pongamos— se lleva
 *    esa transacción entera, y el `catch` no la salva: medido en
 *    `judgment-sink.int.test.ts`, `postgres.js` **rechaza la transacción con el
 *    error original**, así que el llamador recibe como propio un fallo que creyó
 *    manejado y su `INSERT` se va en el rollback. Con transacción propia, lo peor
 *    que puede pasar es que falte una fila en `judgment_records`.
 *
 * 2. **El sink levanta la mano; no se traga nada.** Quien decide que perder un
 *    registro es aceptable es el decorador, que es el único que sabe que del otro
 *    lado hay un usuario esperando. Un sink que devolviera `void` en silencio
 *    dejaría a `onError` sin nada que reportar y a `DATA-033` vacío sin alarma.
 *
 * 3. **Se escribe lo que `DATA-033` enumera y nada más.** `answers` y `stateHash`;
 *    el estado crudo no, el prompt no, la respuesta cruda del proveedor tampoco.
 *    No hay columna para ninguna de las tres y no hay que agregarla: el estado que
 *    llega a un juicio trae texto de terceros (bios, captions, comentarios), y la
 *    retención de esta tabla es permanente.
 */

import type { DecisionPoint, JudgmentAnswer } from "@fastgram/ports";

import type { Database, Executor } from "../client.js";
import { judgmentRecords, JUDGMENT_ADAPTER } from "../schema/index.js";
import { withCompany } from "../tenancy.js";
import type { TenantScope } from "./base.js";

export type JudgmentRecordRow = typeof judgmentRecords.$inferSelect;

/**
 * Una fila de `DATA-033` lista para escribir.
 *
 * **Tiene que ser estructuralmente igual a `JudgmentRecordEntry` de
 * `@fastgram/adapters`.** No es una copia por comodidad: es el contrato entre dos
 * paquetes que no se importan. Los tipos que sí se comparten —`DecisionPoint`,
 * `JudgmentAnswer`— vienen de `@fastgram/ports`, que los dos sí conocen, así que
 * lo único que puede divergir son los campos.
 */
export interface JudgmentRecordInput {
  readonly companyId: string;
  readonly decisionPoint: DecisionPoint;
  /**
   * `DATA-033.subjectType`. El PRD lo describe en prosa (*"trending item, lead,
   * post, campo de perfil"*) y no fija literales, así que es texto libre, igual
   * que la columna. Fijar la taxonomía va con los `DP-00x`, no antes.
   */
  readonly subjectType: string;
  readonly subjectId?: string;
  readonly adapter: string;
  readonly model: string;
  readonly answers: { readonly [questionId: string]: JudgmentAnswer };
  readonly stateHash: string;
  readonly inputTokens?: number;
  readonly latencyMs: number;
}

/**
 * Lo que hay que pasarle a `RecordingJudgment` como `sink`.
 *
 * Se llama `DbJudgmentSink` y no `JudgmentSink` para que en el archivo que monta
 * las dos piezas se lea cuál es cuál.
 */
export interface DbJudgmentSink {
  record(entry: JudgmentRecordInput): Promise<void>;
}

export interface JudgmentSinkOptions {
  /**
   * Rol para el `SET LOCAL ROLE` de la transacción. Mismo significado que en
   * {@link withCompany}: en producción la cadena de conexión ya usa el rol de
   * aplicación y esto sobra; hace falta cuando se conecta como superusuario,
   * porque ahí RLS no existe en la práctica.
   */
  readonly role?: string;
}

type JudgmentAdapterName = (typeof JUDGMENT_ADAPTER)[number];

/**
 * Escribe un `JudgmentRecord` en la transacción del que llama.
 *
 * Es el camino para quien ya tiene una transacción abierta **y quiere que el
 * registro comparta su suerte** — un worker que escribe por lote, por ejemplo.
 * Para el camino de una petición, donde el registro no puede arrastrar a la
 * decisión, está {@link createJudgmentSink}, que abre la suya.
 *
 * El `companyId` de la fila lo pone el **scope**, no el `entry`: es la regla de
 * `create` en `base.ts` y no se hace una excepción acá. Que el `entry` traiga el
 * suyo es para que el sink pueda derivar el scope cuando nadie se lo pasa; si los
 * dos no coinciden, alguien se equivocó de workspace y se dice en vez de elegir
 * uno en silencio.
 *
 * La lista de campos se escribe entera y a mano —en vez de spreadear el `entry`—
 * porque es la línea de retención de `DATA-033`: un campo nuevo en la entrada no
 * llega a la base hasta que alguien lo agregue acá **y** haya una columna donde
 * ponerlo. Un `...entry` convertiría "agregar un campo al decorador" en "empezar a
 * persistirlo", que es exactamente lo que no puede pasar sin que se piense.
 */
export async function writeJudgmentRecord(
  exec: Executor,
  scope: TenantScope,
  entry: JudgmentRecordInput,
): Promise<JudgmentRecordRow> {
  if (entry.companyId !== scope.companyId) {
    throw new Error(
      "El `companyId` del registro no es el del scope " +
        `(${JSON.stringify(entry.companyId)} vs ${JSON.stringify(scope.companyId)}). ` +
        "Un juicio se registra en el workspace sobre el que se juzgó.",
    );
  }

  const rows = await exec
    .insert(judgmentRecords)
    .values({
      companyId: scope.companyId,
      decisionPoint: entry.decisionPoint,
      subjectType: entry.subjectType,
      // `?? null` en vez de omitir la clave: con `exactOptionalPropertyTypes` no
      // se puede pasar `undefined` explícito, y un NULL escrito es lo mismo que
      // una columna que no se nombra.
      subjectId: entry.subjectId ?? null,
      adapter: assertKnownAdapter(entry.adapter),
      model: entry.model,
      answers: entry.answers,
      stateHash: entry.stateHash,
      inputTokens:
        entry.inputTokens === undefined
          ? null
          : toIntegerMetric(entry.inputTokens, "inputTokens"),
      latencyMs: toIntegerMetric(entry.latencyMs, "latencyMs"),
    })
    .returning();

  const row = rows[0];
  if (row === undefined) {
    throw new Error("El INSERT de judgment_records no devolvió la fila creada.");
  }
  return row;
}

/**
 * Un sink que escribe cada registro en su **propia** transacción.
 *
 * Es lo que se le pasa a `RecordingJudgment`. El precio de la transacción propia
 * es que el registro no es atómico con lo que haya decidido el llamador: si la
 * petición se cae después de juzgar, la fila de `DATA-033` queda igual. Eso es lo
 * correcto acá — la llamada al proveedor ya se pagó y §25.4 la quiere contada—, y
 * es justo lo contrario de lo que querría un ledger de cuota.
 *
 * El precio que **sí** se paga en el camino de la petición es tiempo: el decorador
 * hace `await` del `record`, así que un `INSERT` lento suma a la latencia de la
 * decisión aunque no pueda voltearla. Si algún día molesta, lo que corresponde es
 * un sink que encole —no sacarle el `await` al decorador, que es lo que ordena sus
 * tests.
 */
export function createJudgmentSink(
  db: Database,
  options: JudgmentSinkOptions = {},
): DbJudgmentSink {
  return {
    async record(entry) {
      // `withCompany` valida que sea un UUID y setea `app.current_company`, así
      // que RLS también ve el scope. Un `companyId` que no es UUID falla acá,
      // antes de tocar la base, con un mensaje que lo dice.
      await withCompany(
        db,
        entry.companyId,
        (tx) => writeJudgmentRecord(tx, { companyId: entry.companyId }, entry),
        options,
      );
    },
  };
}

export const judgmentSinkStore = {
  table: judgmentRecords,
  writeJudgmentRecord,
  createJudgmentSink,
};

/**
 * La columna es el enum `judgment_adapter`, no texto libre — el puerto sí declara
 * `adapter` abierto (`JudgmentProvenance.adapter: string`), así que acá hay un
 * escalón y conviene que se note.
 *
 * Sin esto, un adaptador nuevo hace que Postgres tire *"invalid input value for
 * enum judgment_adapter"*, el decorador se lo trague y la tabla quede vacía para
 * ese adaptador sin que nadie entienda por qué. El error de acá dice qué pasó y
 * qué hay que hacer (una migración que agregue el valor).
 */
function assertKnownAdapter(adapter: string): JudgmentAdapterName {
  if (!(JUDGMENT_ADAPTER as readonly string[]).includes(adapter)) {
    throw new Error(
      `Adaptador desconocido para DATA-033: ${JSON.stringify(adapter)}. La columna ` +
        `\`adapter\` es el enum judgment_adapter (${JUDGMENT_ADAPTER.join(" | ")}); ` +
        "un adaptador nuevo necesita una migración que agregue el valor.",
    );
  }
  // El `includes` de arriba es la comprobación; TypeScript no la propaga sobre una
  // tupla `readonly string[]`.
  return adapter as JudgmentAdapterName;
}

/**
 * Las dos métricas son `integer` con un CHECK de no-negatividad.
 *
 * Un `1234.5` —que ningún adaptador produce hoy, porque todos miden con
 * `Date.now()`, pero que un adaptador con `performance.now()` produciría— haría
 * fallar el `INSERT` con *"invalid input syntax for type integer"*, y ese fallo lo
 * absorbe el decorador: se perderían **todos** los registros de ese adaptador en
 * silencio. Redondear medio milisegundo no le cambia nada a §25.4; perder la serie
 * entera sí.
 */
function toIntegerMetric(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      `\`${field}\` inválido para DATA-033: ${String(value)}. Se espera un número ` +
        "finito y no negativo (la columna es integer con CHECK >= 0).",
    );
  }
  return Math.round(value);
}
