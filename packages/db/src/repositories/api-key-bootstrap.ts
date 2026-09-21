/**
 * Bootstrap de autenticación — PRD §9.1, `FR-180`.
 *
 * Es la **única** función de este paquete que no lleva `companyId` en la firma,
 * y tiene que seguir siéndolo. La razón no es una excepción a la regla: es que
 * acá el `companyId` es el **resultado**, no un parámetro. Todavía no hay
 * tenant que scopear.
 *
 * Por debajo llama a `app.resolve_api_key`, una función `SECURITY DEFINER`
 * (migración `0003`). Sin ella, con el rol `fastgram_app` de producción el
 * `FORCE ROW LEVEL SECURITY` de `api_keys` devolvería cero filas y **toda la
 * API respondería 401**. En desarrollo, con superusuario, funcionaría — que es
 * lo que vuelve peligroso al camino directo.
 *
 * Si algún día aparece otra función sin `companyId` en este directorio, hay que
 * justificarla con el mismo rigor o no existe.
 */
import { sql } from "drizzle-orm";

import type { Database, Transaction } from "../client.js";

export interface ApiKeyBootstrapRow {
  readonly apiKeyId: string;
  readonly companyId: string;
  readonly kind: "workspace" | "partner";
  /** `null` si sigue viva. La app decide; acá no se filtra. */
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  /** Estado del workspace. `soft_deleted` es causa de 401 (PRD `FR-180`). */
  readonly companyStatus: string;
}

interface RawRow {
  api_key_id: string;
  company_id: string;
  kind: string;
  revoked_at: string | Date | null;
  expires_at: string | Date | null;
  company_status: string;
}

/**
 * Resuelve el hash de una API key.
 *
 * Devuelve la fila **aunque esté revocada o vencida**, a propósito: el PRD
 * distingue ocho causas de 401 y, si bien el cuerpo de la respuesta es idéntico
 * para todas —para no decirle a quien sondea si el token existe—, el log sí
 * tiene que distinguirlas. "Revocada hace dos días" y "nunca existió" piden
 * respuestas operativas distintas.
 *
 * Recibe el **hash**, nunca el token en claro: hashear es responsabilidad de
 * quien tiene el token, y así el secreto no cruza esta frontera.
 */
export async function resolveApiKeyByHash(
  exec: Database | Transaction,
  hash: string,
): Promise<ApiKeyBootstrapRow | null> {
  const filas = await exec.execute(
    sql`select api_key_id, company_id, kind, revoked_at, expires_at, company_status
        from app.resolve_api_key(${hash})`,
  );

  const fila = (filas as unknown as RawRow[])[0];
  if (fila === undefined) return null;

  return {
    apiKeyId: fila.api_key_id,
    companyId: fila.company_id,
    kind: fila.kind === "partner" ? "partner" : "workspace",
    revokedAt: toDate(fila.revoked_at),
    expiresAt: toDate(fila.expires_at),
    companyStatus: fila.company_status,
  };
}

function toDate(v: string | Date | null): Date | null {
  if (v === null) return null;
  return v instanceof Date ? v : new Date(v);
}
