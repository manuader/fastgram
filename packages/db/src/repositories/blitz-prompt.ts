/**
 * El lado de la base de «crear desde prompt» — `EXT-009`, `PU-BLITZ-003`,
 * migración `0012`.
 *
 * ## El ciclo de un pedido
 *
 * ```
 *   API    createPromptRequest (queued) + encolar, en la misma transacción
 *   worker lockPromptRequest → markPromptRequestRunning
 *          … planificar y escribir la copy, fuera de transacción …
 *          lockPromptRequest → completePromptRequest (done + sugerencias)
 *                            o failPromptRequest (failed + código)
 *   API    findPromptRequest + listPromptSuggestionIds, para el polling
 * ```
 *
 * ## La guarda contra la reentrega
 *
 * pg-boss puede entregar el mismo job dos veces. Lo que lo hace idempotente
 * es que **cerrar** el pedido —insertar sus sugerencias y pasarlo a `done`—
 * pasa en una transacción que primero toma la fila con `FOR UPDATE`
 * ({@link lockPromptRequest}) y mira que siga abierta. La segunda entrega
 * espera, ve `done` y no inserta nada. Sin el lock las dos verían `running` y
 * el usuario recibiría el doble de piezas de las que pidió.
 *
 * A diferencia del refill, acá **no hay tope de cola**: el usuario pidió N y
 * entran N. El refill sigue contando todas las `queued`, así que un pedido de 5
 * frena el relleno hasta que se consuman, que es lo que corresponde: la cola
 * ya tiene lo que el usuario quiere ver.
 */

import { and, eq, inArray, sql } from "drizzle-orm";

import type { Executor } from "../client.js";
import { blitzPromptRequests, suggestions } from "../schema/blitz.js";
import type { TenantScope } from "./base.js";
import { SUGGESTION_QUEUE_ORDER } from "./blitz-acceptance.js";
import type { QueuedSuggestionDraft } from "./discovery-queue.js";

export type BlitzPromptRequestRow = typeof blitzPromptRequests.$inferSelect;
export type BlitzPromptStatus = BlitzPromptRequestRow["status"];

export interface NewPromptRequest {
  readonly prompt: string;
  /** `null` = lo decide el content mix. */
  readonly contentType:
    "slideshow" | "wall-of-text" | "green-screen" | "video-hook" | null;
  readonly count: number;
  /**
   * `0022`: la referencia de un «Remix this» (Inspiration). Quien llama ya
   * comprobó que es de este workspace.
   */
  readonly sourceTrendingItemId?: string | null;
}

/** Crea el pedido en `queued`. El job lo encola quien llama, en la misma transacción. */
export async function createPromptRequest(
  exec: Executor,
  scope: TenantScope,
  input: NewPromptRequest,
): Promise<BlitzPromptRequestRow> {
  const [row] = await exec
    .insert(blitzPromptRequests)
    .values({
      companyId: scope.companyId,
      prompt: input.prompt,
      contentType: input.contentType,
      count: input.count,
      status: "queued",
      sourceTrendingItemId: input.sourceTrendingItemId ?? null,
    })
    .returning();
  if (row === undefined) throw new Error("El INSERT del pedido no devolvió fila.");
  return row;
}

/** El pedido, sin lock. `null` si no existe **en este workspace**. */
export async function findPromptRequest(
  exec: Executor,
  scope: TenantScope,
  requestId: string,
): Promise<BlitzPromptRequestRow | null> {
  const filas = await exec
    .select()
    .from(blitzPromptRequests)
    .where(
      and(
        eq(blitzPromptRequests.companyId, scope.companyId),
        eq(blitzPromptRequests.id, requestId),
      ),
    )
    .limit(1);
  return filas[0] ?? null;
}

/**
 * El pedido con `FOR UPDATE` hasta el fin de la transacción. Es la guarda
 * contra la reentrega (ver la cabecera): quien llame tiene que estar dentro de
 * una transacción.
 */
export async function lockPromptRequest(
  exec: Executor,
  scope: TenantScope,
  requestId: string,
): Promise<BlitzPromptRequestRow | null> {
  const filas = await exec
    .select()
    .from(blitzPromptRequests)
    .where(
      and(
        eq(blitzPromptRequests.companyId, scope.companyId),
        eq(blitzPromptRequests.id, requestId),
      ),
    )
    .for("update")
    .limit(1);
  return filas[0] ?? null;
}

const OPEN: readonly BlitzPromptStatus[] = ["queued", "running"];

/** ¿El pedido todavía espera un resultado? `done` y `failed` son finales. */
export function isOpenPromptRequest(row: {
  readonly status: BlitzPromptStatus;
}): boolean {
  return OPEN.includes(row.status);
}

/** `queued → running`. No toca uno cerrado. Devuelve si cambió. */
export async function markPromptRequestRunning(
  exec: Executor,
  scope: TenantScope,
  requestId: string,
): Promise<boolean> {
  const filas = await exec
    .update(blitzPromptRequests)
    .set({ status: "running", updatedAt: sql`now()` })
    .where(
      and(
        eq(blitzPromptRequests.companyId, scope.companyId),
        eq(blitzPromptRequests.id, requestId),
        inArray(blitzPromptRequests.status, [...OPEN]),
      ),
    )
    .returning({ id: blitzPromptRequests.id });
  return filas.length > 0;
}

/**
 * Cierra el pedido como `failed` con un código estable. No toca uno ya
 * cerrado: un `done` no se vuelve `failed` por una entrega tardía.
 */
export async function failPromptRequest(
  exec: Executor,
  scope: TenantScope,
  requestId: string,
  failureReason: string,
): Promise<boolean> {
  const filas = await exec
    .update(blitzPromptRequests)
    .set({ status: "failed", failureReason, updatedAt: sql`now()` })
    .where(
      and(
        eq(blitzPromptRequests.companyId, scope.companyId),
        eq(blitzPromptRequests.id, requestId),
        inArray(blitzPromptRequests.status, [...OPEN]),
      ),
    )
    .returning({ id: blitzPromptRequests.id });
  return filas.length > 0;
}

/**
 * Inserta las sugerencias del pedido y lo pasa a `done`. **Llamar con el
 * pedido bloqueado** ({@link lockPromptRequest}) y abierto: es lo que la hace
 * idempotente ante la reentrega.
 *
 * El `created_at` de cada fila es `now()` menos `ord` microsegundos: dentro de
 * un pedido, la primera planificada queda como la «más nueva» y sale primera
 * con el `QUEUE_ORDER` de siempre. Sin el escalón las N comparten el `now()` de
 * la transacción y el orden lo decidiría el desempate por un id aleatorio.
 *
 * Devuelve los ids **en el orden de la cola**.
 */
export async function completePromptRequest(
  exec: Executor,
  scope: TenantScope,
  requestId: string,
  drafts: readonly QueuedSuggestionDraft[],
): Promise<readonly string[]> {
  if (drafts.length === 0) {
    throw new Error("Un pedido sin sugerencias se cierra con failPromptRequest.");
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

  await exec.execute(sql`
    with drafts as (
      select *
        from jsonb_to_recordset(${payload}::jsonb)
          as d(ord int, content_type text, ai_explanation text,
               angle_id uuid, influencer_id uuid, text_style_preset_id text,
               generated_text text, build_plan jsonb)
    ),
    -- \`0022\`: la referencia de un «Remix this». Con el \`company_id\` en el
    -- join: la FK no impide apuntar a una referencia de otra marca.
    src as (
      select t.id, t.permalink
        from blitz_prompt_requests r
        join trending_items t
          on t.id = r.source_trending_item_id
         and (t.company_id is null or t.company_id = r.company_id)
       where r.id = ${requestId}::uuid
         and r.company_id = ${scope.companyId}::uuid
    )
    insert into suggestions
      (company_id, content_type, ai_explanation, angle_id, influencer_id,
       text_style_preset_id, generated_text, build_plan, status,
       prompt_request_id, remix_source_url, source_trending_item_id, created_at)
    select ${scope.companyId}::uuid,
           drafts.content_type::suggestion_content_type,
           drafts.ai_explanation,
           drafts.angle_id,
           drafts.influencer_id,
           drafts.text_style_preset_id,
           drafts.generated_text,
           drafts.build_plan,
           'queued'::suggestion_status,
           ${requestId}::uuid,
           (select permalink from src),
           (select id from src),
           now() - make_interval(secs => drafts.ord / 1000000.0)
      from drafts
  `);

  const cerrado = await exec
    .update(blitzPromptRequests)
    .set({ status: "done", failureReason: null, updatedAt: sql`now()` })
    .where(
      and(
        eq(blitzPromptRequests.companyId, scope.companyId),
        eq(blitzPromptRequests.id, requestId),
        inArray(blitzPromptRequests.status, [...OPEN]),
      ),
    )
    .returning({ id: blitzPromptRequests.id });
  if (cerrado.length === 0) {
    // Con el lock tomado y el pedido abierto no es alcanzable: si pasa, las
    // filas de arriba no deberían quedar. Lanzar hace volver atrás todo.
    throw new Error(`El pedido ${requestId} no estaba abierto al cerrarlo.`);
  }
  return listPromptSuggestionIds(exec, scope, requestId);
}

/**
 * Las sugerencias que produjo un pedido, **en el orden de la cola**, en
 * cualquier estado: una ya aceptada o descartada sigue siendo parte de lo que
 * el pedido produjo.
 */
export async function listPromptSuggestionIds(
  exec: Executor,
  scope: TenantScope,
  requestId: string,
): Promise<readonly string[]> {
  const filas = await exec
    .select({ id: suggestions.id })
    .from(suggestions)
    .where(
      and(
        eq(suggestions.companyId, scope.companyId),
        eq(suggestions.promptRequestId, requestId),
      ),
    )
    .orderBy(...SUGGESTION_QUEUE_ORDER);
  return filas.map((f) => f.id);
}

export const blitzPromptStore = {
  table: blitzPromptRequests,
  createPromptRequest,
  findPromptRequest,
  lockPromptRequest,
  isOpenPromptRequest,
  markPromptRequestRunning,
  failPromptRequest,
  completePromptRequest,
  listPromptSuggestionIds,
};
