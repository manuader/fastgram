/**
 * Bootstrap del workspace de una sesión — `P1-AUTH-002`, PRD §9.1, §9.2.
 *
 * Segunda función de este directorio sin `companyId` en la firma, y por la misma
 * razón que `resolveApiKeyByHash`: el `companyId` es el **resultado**. Una sesión
 * de `apps/web` trae un usuario verificado; el workspace sobre el que opera sale
 * de sus membresías.
 *
 * El scope de esta consulta es el **usuario**: `app.resolve_session_workspace`
 * (migración `0012`) filtra por `user_id` y devuelve un solo `company_id`. Ese
 * `WHERE` es lo único que aísla —la función es `SECURITY DEFINER` y RLS no la
 * alcanza—, así que su test corre **sin** GUC y sin `SET ROLE` además de con el
 * rol de la app (trampa 26 de `docs/HANDOFF.md`: si RLS tapa el `WHERE`, el test
 * no mide el `WHERE`).
 *
 * Recibe un `userId` que **ya verificó** el proveedor de identidad. Llamarla con
 * un id que vino del cliente sería dejarle elegir workspace a cualquiera.
 */
import { sql } from "drizzle-orm";

import type { Database, Transaction } from "../client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * El workspace sobre el que opera `userId`, o `null` si no tiene ninguna
 * membresía `active` en un workspace vivo.
 *
 * Regla (en SQL, `0012`): `users.default_workspace_id` si es una membresía
 * activa; si no, la membresía activa más vieja (`created_at`, `id`).
 */
export async function resolveSessionWorkspace(
  exec: Database | Transaction,
  userId: string,
): Promise<string | null> {
  // Un id que no es uuid no puede tener membresías, y a Postgres le llegaría
  // como error de sintaxis (`22P02`) — que no es "no tiene workspace".
  if (!UUID_RE.test(userId)) return null;

  const filas = await exec.execute(
    sql`select app.resolve_session_workspace(${userId}::uuid) as company_id`,
  );
  const fila = (filas as unknown as { company_id: string | null }[])[0];
  return fila?.company_id ?? null;
}
