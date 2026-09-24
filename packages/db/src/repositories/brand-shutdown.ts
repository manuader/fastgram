/**
 * Apagar lo que una marca tiene en marcha al borrarla — `P1-TENANT-005`,
 * `FR-160` (borrado de workspace con sus advertencias sobre post slots).
 *
 * ## Por qué hace falta
 *
 * Borrar una marca era un `UPDATE companies SET status = 'soft_deleted'` y
 * nada más. Lo que ya estaba en la cola seguía su curso: el job de
 * `publishing` de un post `SCHEDULED` no mira el estado de la company, así que
 * **publicaba igual** en la cuenta de una marca que el dueño acababa de
 * borrar. Lo mismo el barrido de publicación con los slots planificados y
 * las campañas con su cron.
 *
 * ## Qué hace, todo en la transacción del borrado
 *
 * - posts `BUILDING`/`CREATED`/`SCHEDULED`/`AWAITING_RECONNECT` → `CANCELLED`
 *   (los mismos estados cancelables de `POST /posts/cancel`). El handler de
 *   publicación saltea todo lo que no está `SCHEDULED`, así que el job que ya
 *   estaba encolado no hace nada. `UPLOADING_TO_TIKTOK` e `IN_USER_INBOX` no
 *   se tocan: ya están del lado de TikTok y decir "cancelado" sería mentir.
 * - slots planificados `planned` → **borrados**. El enum no tiene
 *   `cancelled` y agregarlo exige `ALTER TYPE … ADD VALUE`; un slot es un
 *   plan, no un hecho, y la marca desaparece.
 * - estrategia → `autonomy = 'manual'`: apaga el piloto aunque alguien la
 *   restaurara a mano.
 * - campañas `GENERATING`/`REVIEW`/`BUILDING`/`ACTIVE` → `CANCELLED`.
 *
 * Setea `app.current_company` **local** a la transacción: el borrado corre
 * sin tenant (`withoutCompany`, es una ruta del dueño) y, con el rol de la
 * aplicación, RLS escondería las filas de la marca.
 */
import { sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import { CURRENT_COMPANY_SETTING } from "../tenancy.js";

export interface BrandShutdownResult {
  readonly postsCancelled: number;
  readonly plannedSlotsRemoved: number;
  readonly automationsCancelled: number;
  readonly autopilotDisabled: boolean;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function shutdownBrandActivity(
  exec: Executor,
  companyId: string,
  now: Date,
): Promise<BrandShutdownResult> {
  if (!UUID_RE.test(companyId)) throw new Error("companyId inválido");
  await exec.execute(
    sql`select set_config(${CURRENT_COMPANY_SETTING}, ${companyId}, true)`,
  );

  const cancelled = (await exec.execute(sql`
    update posts
       set status = 'CANCELLED', updated_at = ${now.toISOString()}::timestamptz
     where company_id = ${companyId}::uuid
       and status in ('BUILDING', 'CREATED', 'SCHEDULED', 'AWAITING_RECONNECT')
    returning id
  `)) as unknown as unknown[];

  const slots = (await exec.execute(sql`
    delete from planned_slots
     where company_id = ${companyId}::uuid and status = 'planned'
    returning id
  `)) as unknown as unknown[];

  const campaigns = (await exec.execute(sql`
    update automations
       set status = 'CANCELLED', cancelled_at = ${now.toISOString()}::timestamptz, updated_at = ${now.toISOString()}::timestamptz
     where company_id = ${companyId}::uuid
       and status in ('GENERATING', 'REVIEW', 'BUILDING', 'ACTIVE')
    returning id
  `)) as unknown as unknown[];

  const pilot = (await exec.execute(sql`
    update brand_strategies
       set autonomy = 'manual', updated_at = ${now.toISOString()}::timestamptz
     where company_id = ${companyId}::uuid and autonomy <> 'manual'
    returning company_id
  `)) as unknown as unknown[];

  return {
    postsCancelled: cancelled.length,
    plannedSlotsRemoved: slots.length,
    automationsCancelled: campaigns.length,
    autopilotDisabled: pilot.length > 0,
  };
}
