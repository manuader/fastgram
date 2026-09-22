/**
 * Ledger de cuota — `DATA-029`, PRD §16.2 y §9.4.
 *
 * ## Por qué esto no sale de la fábrica genérica
 *
 * Porque lo que hace falta acá no es leer y escribir: es **leer bloqueando**.
 * §9.4 pide *"reservas atómicas de cuota antes de trabajo costoso"*, y una
 * lectura seguida de una escritura no es atómica. Con el aislamiento por
 * defecto de Postgres —READ COMMITTED— dos peticiones simultáneas del mismo
 * workspace leen el mismo saldo, las dos deciden que hay lugar, y las dos
 * consumen. El cliente obtiene un save gratis y nadie se entera: no hay error,
 * no hay log, sólo una fila con un contador más bajo del que corresponde.
 *
 * Es el mismo patrón que ya mordió en el limitador de tasa, donde 120 de 120
 * peticiones pasaron contra un límite de 60. Ahí se resolvió con
 * compare-and-swap porque el store era genérico; acá hay una base de datos, así
 * que se resuelve con `SELECT … FOR UPDATE`, que es más simple y no reintenta.
 *
 * ## El orden importa: crear y después bloquear
 *
 * Un `SELECT … FOR UPDATE` sobre una fila que no existe no bloquea nada — no
 * hay qué bloquear— así que dos peticiones concurrentes sobre un workspace
 * cuyo período todavía no tiene ledger volverían a correr la misma carrera. Por
 * eso {@link lockPeriod} inserta primero con `ON CONFLICT DO NOTHING` (que sí
 * serializa: el segundo espera al primero) y recién después bloquea.
 *
 * Y ese orden es además lo que hace seguro el arrastre del saldo comprado: ver
 * {@link lockPeriod}.
 */

import { and, eq, sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import { quotaLedgers } from "../schema/index.js";
import type { TenantScope } from "./base.js";

export type QuotaLedgerRow = typeof quotaLedgers.$inferSelect;

/**
 * Lo que se escribe al crear el ledger de un período nuevo.
 *
 * **`contentSavesPurchased` no está acá, y su ausencia es la corrección de
 * `P1-QUOTA-012`.** Era un campo opcional que nadie pasaba nunca, así que cada
 * período nuevo arrancaba en 0 y el saldo comprado del cliente desaparecía en
 * silencio al cambiar de ciclo — contra §16.2, que dice que no caduca. Un valor
 * que el llamador **no puede conocer** no es un default suyo: lo arrastra este
 * repositorio ({@link lockPeriod}), que es el único que sabe qué período viene
 * antes. Dejarlo como campo opcional mantenía abierta la única forma de volver a
 * perderlo: pasar 0 sin querer.
 */
export interface NewPeriodDefaults {
  /** Cupo del plan para el período. Sale de `PLANS[plan].contentSaves`. */
  readonly contentSavesIncluded: number;
  readonly aiCredits?: number;
  readonly warmedPostSlots?: number;
}

/**
 * Deja el ledger del período creado y **bloqueado** hasta el fin de la
 * transacción.
 *
 * Quien llame tiene que estar dentro de una transacción: fuera de una, el
 * `FOR UPDATE` se libera al terminar la sentencia y no protege nada. No se
 * puede comprobar desde acá —el `Executor` no distingue— así que queda escrito.
 *
 * Devuelve la fila tal como está, con el cupo ya aplicado si acaba de crearse.
 *
 * ## El saldo comprado se arrastra acá — `P1-QUOTA-012`, §16.2
 *
 * Los saves comprados **no caducan**. El ledger, en cambio, es una fila por
 * período, así que al cruzar el ancla de facturación aparece una fila nueva y
 * hay que traer el saldo que sobró. Se hace en la creación y no en el job de
 * `quota-reset` por el mismo criterio de la decisión 7 del handoff, que ya se
 * aplicó al reset del cupo incluido: **si dependiera del cron, el saldo
 * comprado de un cliente dependería de que el cron haya corrido.** Acá depende
 * de la primera petición del ciclo, que es la que lo va a usar.
 *
 * *"El período anterior"* es el de **clave máxima estrictamente menor** a la
 * actual, no el mes calendario anterior: las claves son `YYYY-MM-DD` con la
 * fecha de inicio del ciclo (`billingPeriodKey`), ordenan como texto, y un
 * cliente que estuvo inactivo tres meses tiene que arrastrar desde el último
 * período que existe, no desde uno que nunca se creó.
 *
 * ## Por qué el arrastre va DENTRO del INSERT
 *
 * Porque el `ON CONFLICT DO NOTHING` es lo único que serializa a dos
 * transacciones que crean el mismo período a la vez, y **el arrastre tiene que
 * viajar dentro de esa misma sentencia**. Si se hiciera aparte —leer el
 * anterior, y después un `UPDATE … SET purchased = purchased + n` sobre la fila
 * recién creada— las dos transacciones sumarían, y el cliente terminaría el
 * ciclo con el doble del saldo que compró. Sin error y sin log: la única señal
 * sería una factura más baja de lo que corresponde.
 *
 * Con el subselect adentro del INSERT, el segundo concurrente no inserta nada,
 * así que tampoco arrastra nada. Y una segunda llamada a `lockPeriod` sobre un
 * período que ya existe tampoco vuelve a arrastrar: por eso el arrastre **no**
 * puede ir en un `ON CONFLICT DO UPDATE`.
 *
 * ## Lo que este diseño NO cubre, dicho para que no se redescubra
 *
 * El período anterior se lee **sin bloquear**. Queda una ventana de microsegundos
 * en el borde del ciclo: si un reembolso al bucket `purchased` del período
 * *anterior* se confirma entre el snapshot de este INSERT y su commit, ese save
 * queda contabilizado en la fila vieja y no viaja a la nueva. Hace falta que un
 * build cobrado a `purchased` en el ciclo viejo falle exactamente mientras
 * entra la primera petición del ciclo nuevo.
 *
 * Se puede cerrar con un `SELECT … FOR UPDATE` sobre el período anterior
 * **antes** del INSERT —el orden prev → actual no genera deadlock, porque el
 * reembolso sólo bloquea el período que le toca— y el precio es una ida más y
 * un lock extra en el camino caliente de **toda** creación de contenido. Por un
 * save por cliente por ciclo en el peor caso, no se pagó. Si aparece evidencia
 * de que pasa, ése es el arreglo y ése es su costo.
 */
export async function lockPeriod(
  exec: Executor,
  scope: TenantScope,
  period: string,
  defaults: NewPeriodDefaults,
): Promise<QuotaLedgerRow> {
  // Primero crear. `ON CONFLICT DO NOTHING` serializa a los concurrentes: el
  // segundo espera a que el primero confirme y después no inserta nada.
  await exec
    .insert(quotaLedgers)
    .values({
      companyId: scope.companyId,
      period,
      contentSavesIncluded: defaults.contentSavesIncluded,
      // El arrastre del saldo comprado, en la misma sentencia que la creación.
      // El `::uuid` no es decorativo: el parámetro viaja como texto y
      // `uuid = text` no tiene operador, así que sin el casteo esto falla en
      // ejecución y no en compilación.
      contentSavesPurchased: sql`coalesce((
        select anterior.content_saves_purchased
          from ${quotaLedgers} anterior
         where anterior.company_id = ${scope.companyId}::uuid
           and anterior.period < ${period}
         order by anterior.period desc
         limit 1
      ), 0)`,
      aiCredits: defaults.aiCredits ?? 0,
      warmedPostSlots: defaults.warmedPostSlots ?? 0,
    })
    .onConflictDoNothing();

  // Y ahora sí bloquear. A partir de acá, cualquier otra transacción que
  // quiera este mismo ledger espera.
  const filas = await exec
    .select()
    .from(quotaLedgers)
    .where(
      and(eq(quotaLedgers.companyId, scope.companyId), eq(quotaLedgers.period, period)),
    )
    .for("update")
    .limit(1);

  const fila = filas[0];
  if (fila === undefined) {
    // No debería pasar: acabamos de insertarla en esta misma transacción. Si
    // pasa, es que el scope no coincide con el `app.current_company` del GUC y
    // RLS la está ocultando — que es un bug de cableado, no de datos.
    throw new Error(
      `No se pudo bloquear el ledger de ${period}. Casi siempre es que la ` +
        "transacción no tiene seteado `app.current_company` para este workspace.",
    );
  }
  return fila;
}

/** Lee sin bloquear. Para mostrar saldo, nunca para decidir si alcanza. */
export async function readPeriod(
  exec: Executor,
  scope: TenantScope,
  period: string,
): Promise<QuotaLedgerRow | null> {
  const filas = await exec
    .select()
    .from(quotaLedgers)
    .where(
      and(eq(quotaLedgers.companyId, scope.companyId), eq(quotaLedgers.period, period)),
    )
    .limit(1);
  return filas[0] ?? null;
}

/** Los contadores que una consumición o un reembolso pueden mover. */
export interface LedgerCounters {
  readonly contentSavesUsed: number;
  readonly contentSavesPurchased: number;
  readonly overageUnits: number;
}

/**
 * Escribe los contadores del período.
 *
 * Toma valores absolutos y no incrementos a propósito: el cálculo lo hace el
 * dominio (`consumeSave` / `refundSave` en `packages/core`), que es donde está
 * la regla de qué bucket se toca primero. Un `+1` desde acá duplicaría esa
 * regla en SQL, y las dos copias se separarían.
 *
 * Sólo tiene sentido después de {@link lockPeriod} en la misma transacción.
 */
export async function writeCounters(
  exec: Executor,
  scope: TenantScope,
  period: string,
  counters: LedgerCounters,
): Promise<void> {
  await exec
    .update(quotaLedgers)
    .set({
      contentSavesUsed: counters.contentSavesUsed,
      contentSavesPurchased: counters.contentSavesPurchased,
      overageUnits: counters.overageUnits,
      updatedAt: new Date(),
    })
    .where(
      and(eq(quotaLedgers.companyId, scope.companyId), eq(quotaLedgers.period, period)),
    );
}

/**
 * Los swipes diarios, que tienen su propio reloj (00:00 UTC, no el ancla).
 *
 * Se escribe el contador **y** el instante del próximo reset juntos: si se
 * guardaran por separado, una caída en el medio dejaría un contador reiniciado
 * con la marca vieja, o al revés — swipes gratis o swipes perdidos.
 */
export async function writeDailySwipes(
  exec: Executor,
  scope: TenantScope,
  period: string,
  used: number,
  resetAt: Date,
): Promise<void> {
  await exec
    .update(quotaLedgers)
    .set({ dailySwipesUsed: used, dailySwipeResetAt: resetAt, updatedAt: new Date() })
    .where(
      and(eq(quotaLedgers.companyId, scope.companyId), eq(quotaLedgers.period, period)),
    );
}

/** Créditos de AI Studio. Valor absoluto, por la misma razón que los contadores. */
export async function writeAiCredits(
  exec: Executor,
  scope: TenantScope,
  period: string,
  credits: number,
): Promise<void> {
  await exec
    .update(quotaLedgers)
    .set({ aiCredits: credits, updatedAt: new Date() })
    .where(
      and(eq(quotaLedgers.companyId, scope.companyId), eq(quotaLedgers.period, period)),
    );
}

/**
 * El barrido de swipes vencidos — `P1-QUOTA-013`, §9.5 #17.
 *
 * ## Es la única función de este paquete sin `TenantScope`, y por qué
 *
 * Todo lo demás acá lleva scope. Esta no puede: es un **barrido**, corre desde
 * un cron sin petición ni workspace, y lo que tiene que encontrar son
 * justamente los ledgers de las cuentas que **nadie consultó**. Pedirle un
 * `companyId` sería pedirle la lista de todos, que es lo mismo sin la ventaja.
 *
 * Que falte el scope es la señal, igual que en `catalog.ts`. El tamaño de la
 * excepción, con precisión:
 *
 *  - **No devuelve ni una fila de ningún cliente.** Devuelve un entero: cuántas
 *    tocó. No hay forma de leer datos ajenos por acá.
 *  - **Escribe dos columnas de una tabla** (`daily_swipes_used`,
 *    `daily_swipe_reset_at`, más `updated_at`), y **sólo** en filas cuyo propio
 *    `daily_swipe_reset_at` ya venció. No toca ni un contador de content saves:
 *    ésos no se barren nunca, porque su reset **es** la clave del período — al
 *    cruzar el ancla aparece una fila nueva y la vieja es historia de
 *    facturación.
 *  - **No se puede apuntar a un tenant.** No hay parámetro de company, ni acá
 *    ni en la función SQL, así que un payload manipulado en la cola no tiene
 *    dónde escribir un `companyId`.
 *
 * ## Por qué hay una función `SECURITY DEFINER` detrás y no un `UPDATE` pelado
 *
 * Porque `quota_ledgers` tiene `FORCE ROW LEVEL SECURITY` y su política compara
 * `company_id` contra `app.current_company()`. Un barrido corre **sin** GUC, así
 * que la función devuelve NULL, la política no deja pasar nada y el `UPDATE`
 * afectaría **cero filas** — sin error. `withoutCompany` no cambia eso: sólo
 * documenta que se salió del scope, no saltea RLS.
 *
 * Y el modo de falla es el de la trampa 16: en desarrollo la conexión es
 * superusuaria, saltea RLS y el barrido *parece* funcionar; en producción, con
 * `fastgram_app`, no hace nada y nadie se entera. Es el mismo problema que
 * `app.resolve_api_key` (migración `0003`) y se resuelve igual: una función
 * `SECURITY DEFINER` con `search_path` fijo, que hace **una** cosa y está
 * `GRANT`-eada sólo a `fastgram_app`. Ver `0006_quota_swipe_sweep.sql`.
 *
 * ## Los dos instantes los decide el llamador
 *
 * `now` y `nextResetAt` entran como parámetros en vez de calcularse en SQL, por
 * la misma razón que {@link writeCounters} toma valores absolutos: la regla es
 * del dominio. `nextDailyResetUtc` de `@fastgram/core` ya sabe qué es el
 * próximo 00:00 UTC, y una segunda copia en SQL —con el riesgo de que
 * `date_trunc` use la zona de la sesión y no UTC— se separaría de la primera.
 *
 * Eso es además lo que sostiene el invariante que mantiene a este barrido como
 * **red y no mecanismo**: sólo deja la fila en el estado que el camino de
 * lectura calcularía en ese mismo instante. Si nunca corriera, la primera
 * lectura arreglaría la fila igual.
 *
 * @returns cuántas filas se barrieron. Menos que `limit` significa que no quedó
 * nada vencido; igual a `limit` significa que hay que volver a llamar.
 */
export async function sweepExpiredDailySwipes(
  exec: Executor,
  now: Date,
  nextResetAt: Date,
  limit: number,
): Promise<number> {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(`limit tiene que ser un entero positivo, y llegó ${String(limit)}`);
  }
  // Los instantes viajan como **texto ISO** y no como `Date`, y esto es la
  // trampa 18 otra vez: `drizzle()` le cambia los serializadores al cliente
  // postgres.js que recibe, así que un `Date` puesto como parámetro de un
  // `sql` crudo llega al protocolo sin serializar y postgres.js muere con
  // *"The \"string\" argument must be ... Received an instance of Date"*. Medido:
  // con `Date` los ocho tests del barrido fallan en el bind, no en la lógica.
  // El `::timestamptz` es el que hace el casteo del lado del servidor.
  const filas = await exec.execute<{ barridas: number }>(
    sql`select app.sweep_expired_daily_swipes(
          ${now.toISOString()}::timestamptz,
          ${nextResetAt.toISOString()}::timestamptz,
          ${limit}::int
        )::int as barridas`,
  );
  const fila = filas[0];
  if (fila === undefined) {
    // Una función escalar siempre devuelve una fila. Si no está, es que alguien
    // cambió la firma de la función SQL y no este archivo.
    throw new Error("app.sweep_expired_daily_swipes no devolvió ninguna fila");
  }
  return fila.barridas;
}

export const quotaLedgerStore = {
  table: quotaLedgers,
  lockPeriod,
  readPeriod,
  writeCounters,
  writeDailySwipes,
  writeAiCredits,
  sweepExpiredDailySwipes,
  /** Para tests y para soporte: cuántos períodos tiene un workspace. */
  async countPeriods(exec: Executor, scope: TenantScope): Promise<number> {
    const filas = await exec
      .select({ value: sql<number>`count(*)::int` })
      .from(quotaLedgers)
      .where(eq(quotaLedgers.companyId, scope.companyId));
    return filas[0]?.value ?? 0;
  },
};
