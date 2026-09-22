/**
 * El lado de la base del cargo de créditos de un influencer — `P1-DATA-016`,
 * `FR-080`, PRD §9.4.
 *
 * ## Por qué vive acá y no en `apps/worker`
 *
 * Por lo mismo que `content-build.ts`: esto es SQL, y `apps/worker` **no puede
 * importar `drizzle-orm`**. No es alcanzable a propósito — es lo que impide que
 * un proceso arme su propio `WHERE` y se olvide el tenant.
 *
 * ## Qué hay acá que la fábrica genérica no da
 *
 * Dos cosas, y cada una existe por una carrera distinta:
 *
 *  1. {@link lockInfluencer} — **leer bloqueando**. Igual que
 *     `contentBuildStore.lockContent`, y por el mismo motivo: el pipeline dura
 *     15–20 minutos (`FR-080`), así que el handler no puede tener el trabajo
 *     dentro de una transacción. Lee, suelta, trabaja, y vuelve a tomar. Todo lo
 *     que decide en la segunda transacción depende de que la fila no se le haya
 *     movido.
 *
 *  2. {@link claimCreditsRefund} — **el reembolso, una sola vez**. Ésta no es una
 *     comodidad: es la guarda, y está escrita como una sola sentencia
 *     justamente para que no dependa de que el llamador se acuerde de mirar
 *     `creditsRefundedAt`.
 *
 * ## Sobre la guarda, y la trampa 24
 *
 * La trampa 24 del handoff dice que el test de doble reembolso del content save
 * pasaba **con la guarda quitada**: lo que frenaba el segundo reembolso era el
 * chequeo de estado que corre antes, y la guarda vivía detrás, inalcanzable. Una
 * guarda que nadie puede alcanzar no es una guarda: es un comentario.
 *
 * Por eso acá el orden se invierte y la marca **es** la operación. El handler no
 * pregunta «¿ya se reembolsó?» y después reembolsa: le pide a la base que le
 * entregue el cargo, y la base se lo entrega **a lo sumo una vez**. Quien recibe
 * `null` no tiene nada que devolver, y no hay forma de escribir el camino en el
 * orden equivocado.
 */

import { and, eq, isNotNull, isNull } from "drizzle-orm";

import type { Executor } from "../client.js";
import { influencers } from "../schema/index.js";
import type { TenantScope } from "./base.js";

export type InfluencerRow = typeof influencers.$inferSelect;

/**
 * Lee el influencer y lo deja **bloqueado** hasta el fin de la transacción.
 *
 * Devuelve `null` si no existe o es de otro workspace — los dos casos son lo
 * mismo para quien llama (PRD §9.2: el `404` invisible, bajado al worker).
 *
 * **No filtra por `isActive`, y es una decisión.** `isActive` es el
 * activar/desactivar reversible del cap de 50 (`core/workspace/influencers.ts`),
 * no un borrado: la fila sigue existiendo y el pipeline sigue corriendo. Si el
 * lock la escondiera, desactivar un influencer mientras se entrena haría que el
 * fallo posterior no encontrara la fila y **los 250 créditos no volvieran** —
 * sin error y sin log. Es lo contrario del caso de `lockContent`, donde el
 * filtro de soft-delete está puesto **para no** reembolsar: ahí el PRD dice dos
 * veces que borrar no devuelve el save; acá no dice nada parecido de desactivar,
 * y un pipeline que falló falló igual.
 *
 * Quien llame tiene que estar dentro de una transacción: fuera de una, el
 * `FOR UPDATE` se libera al terminar la sentencia y no protege nada. El
 * `Executor` no distingue, así que queda escrito.
 */
export async function lockInfluencer(
  exec: Executor,
  scope: TenantScope,
  influencerId: string,
): Promise<InfluencerRow | null> {
  const filas = await exec
    .select()
    .from(influencers)
    .where(
      and(eq(influencers.companyId, scope.companyId), eq(influencers.id, influencerId)),
    )
    .for("update")
    .limit(1);

  return filas[0] ?? null;
}

/** Lo que hay que devolverle al ledger, y a cuál. */
export interface InfluencerCreditsCharge {
  /** `quota_ledgers.period` al que se cobró. */
  readonly period: string;
  /** Créditos reservados. Es lo que se devuelve, ni más ni menos. */
  readonly charged: number;
}

/**
 * Toma el cargo para reembolsarlo, **a lo sumo una vez**.
 *
 * Marca `creditsRefundedAt` y devuelve el cargo en la **misma sentencia**. Quien
 * recibe un objeto es el único que lo va a recibir y tiene que devolver esos
 * créditos; quien recibe `null` no tiene nada que hacer, y da igual por cuál de
 * los cuatro motivos: la fila no existe, es de otro workspace, nunca se cobró, o
 * alguien ya reembolsó.
 *
 * ## Por qué una sola sentencia alcanza, incluso sin `lockInfluencer` antes
 *
 * Con READ COMMITTED —el default de Postgres— dos `UPDATE` concurrentes sobre la
 * misma fila no corren a la vez: el segundo espera a que el primero confirme y
 * **vuelve a evaluar su `WHERE`** contra la versión nueva. Ahí
 * `credits_refunded_at` ya no es `null`, no matchea, y `RETURNING` no devuelve
 * ninguna fila. Es lo que convierte al doble reembolso en imposible en vez de en
 * improbable.
 *
 * Un `SELECT` seguido de un `UPDATE` **no** tiene esa propiedad: las dos
 * transacciones leen `null` y las dos devuelven. Es la misma carrera del
 * limitador de tasa que pasó 120 de 120 contra un límite de 60.
 *
 * Nada de esto pide un lock previo, y por eso es seguro llamarla sola. Si el
 * handler ya tiene la fila bloqueada con {@link lockInfluencer}, tampoco molesta:
 * el lock es reentrante dentro de la misma transacción.
 *
 * **Lo que NO cubre:** una transacción en `REPEATABLE READ` o `SERIALIZABLE`, que
 * en vez de reevaluar aborta con un error de serialización. No es un problema
 * hoy —nadie sube el nivel de aislamiento en este repo— pero si alguien lo
 * subiera, el segundo reembolso fallaría ruidosamente en vez de devolver `null`,
 * y quien llame tiene que estar preparado para reintentar. Se dice acá para que
 * no se descubra en producción.
 *
 * @param refundedAt el instante del reembolso. Sale del puerto `Clock`, no de
 * `now()` de Postgres: es el reloj que los tests fijan.
 */
export async function claimCreditsRefund(
  exec: Executor,
  scope: TenantScope,
  influencerId: string,
  refundedAt: Date,
): Promise<InfluencerCreditsCharge | null> {
  const filas = await exec
    .update(influencers)
    .set({ creditsRefundedAt: refundedAt, updatedAt: refundedAt })
    .where(
      and(
        eq(influencers.companyId, scope.companyId),
        eq(influencers.id, influencerId),
        // Sin cargo no hay nada que devolver. El CHECK
        // `influencers_refund_requires_charge` dice lo mismo desde la base; acá
        // evita además marcar como reembolsada una fila que nunca se cobró.
        isNotNull(influencers.creditsCharged),
        // La guarda. Es este predicado, y no una lectura previa, lo que hace que
        // el segundo intento se vaya con las manos vacías.
        isNull(influencers.creditsRefundedAt),
      ),
    )
    .returning({
      period: influencers.creditsPeriod,
      charged: influencers.creditsCharged,
    });

  const fila = filas[0];
  if (fila === undefined) return null;

  if (fila.period === null || fila.charged === null) {
    // Imposible: el CHECK `influencers_credits_period_with_charged` exige que
    // vengan de a dos, y el `WHERE` ya pidió `charged is not null`. Si pasa, es
    // que alguien soltó el CHECK — y devolver un reembolso a medias sería peor
    // que no devolverlo, porque la fila ya quedó marcada como reembolsada.
    throw new Error(
      `El influencer ${influencerId} tiene un cargo incompleto (period=${String(
        fila.period,
      )}, charged=${String(fila.charged)}). Revisá que los CHECK de ` +
        "`influencers` sigan en su lugar.",
    );
  }

  return { period: fila.period, charged: fila.charged };
}

export const influencerCreditsStore = {
  table: influencers,
  lockInfluencer,
  claimCreditsRefund,
};
