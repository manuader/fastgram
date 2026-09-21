/**
 * Helper de tenencia — IMPL §2.4 capa 1.
 *
 * RLS compara `company_id` contra `app.current_company()`, que lee el GUC
 * `app.current_company`. Ese GUC se setea **por transacción** (`set_config(..., true)`
 * = `SET LOCAL`), nunca por conexión: con un pool, un valor que sobrevive al commit se
 * filtra al próximo request que reutilice esa conexión, y eso es exactamente el bug
 * que RLS venía a impedir.
 *
 * Si el GUC no está seteado, `app.current_company()` devuelve `NULL` y todas las
 * políticas evalúan a falso: **sin scope no se ve nada**. Falla cerrado a propósito.
 */

import { sql } from "drizzle-orm";

import type { Database, Transaction } from "./client.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Identificador SQL simple. `SET LOCAL ROLE` no admite parámetros; ver abajo. */
const SQL_IDENT_RE = /^[a-z_][a-z0-9_]*$/;

export const CURRENT_COMPANY_SETTING = "app.current_company";

/** El rol de aplicación que crea `drizzle/0002_tenancy_rls.sql`. */
export const APP_ROLE = "fastgram_app";

export interface WithCompanyOptions {
  /**
   * Rol al que hacer `SET LOCAL ROLE` dentro de la transacción.
   *
   * En producción la cadena de conexión ya debería usar el rol de aplicación y esto
   * sobra. Hace falta cuando se conecta como superusuario —tests con Testcontainers,
   * consolas de operación—, porque **un superusuario saltea RLS por completo** y las
   * políticas dejan de existir en la práctica sin que nada avise.
   */
  readonly role?: string;
}

/**
 * Abre una transacción con `app.current_company` seteado y ejecuta `fn` adentro.
 * Es el único camino soportado para tocar tablas de cliente.
 */
export async function withCompany<T>(
  db: Database,
  companyId: string,
  fn: (tx: Transaction) => Promise<T>,
  options: WithCompanyOptions = {},
): Promise<T> {
  assertUuid(companyId);

  return db.transaction(async (tx) => {
    if (options.role !== undefined) {
      if (!SQL_IDENT_RE.test(options.role)) {
        throw new Error(
          `Rol inválido: ${JSON.stringify(options.role)}. ` +
            "`SET LOCAL ROLE` no admite parámetros, así que sólo se aceptan " +
            "identificadores [a-z_][a-z0-9_]*.",
        );
      }
      // Seguro por la validación de arriba: el regex no deja pasar comillas ni espacios.
      await tx.execute(sql.raw(`set local role ${options.role}`));
    }

    // `true` = SET LOCAL: se revierte al terminar la transacción.
    await tx.execute(
      sql`select set_config(${CURRENT_COMPANY_SETTING}, ${companyId}, true)`,
    );

    return fn(tx);
  });
}

/**
 * Como `withCompany` pero **sin** company: para trabajo que no es de un tenant
 * (catálogo global, onboarding previo al workspace, migraciones de datos).
 * Existe para que quede explícito en el código cuándo se sale del scope, en vez de que
 * alguien llame a `db.transaction` directo y nadie lo note en el diff.
 */
export async function withoutCompany<T>(
  db: Database,
  fn: (tx: Transaction) => Promise<T>,
  options: WithCompanyOptions = {},
): Promise<T> {
  return db.transaction(async (tx) => {
    if (options.role !== undefined) {
      if (!SQL_IDENT_RE.test(options.role)) {
        throw new Error(`Rol inválido: ${JSON.stringify(options.role)}.`);
      }
      await tx.execute(sql.raw(`set local role ${options.role}`));
    }
    return fn(tx);
  });
}

function assertUuid(value: string): void {
  if (!UUID_RE.test(value)) {
    throw new Error(
      `companyId inválido: ${JSON.stringify(value)}. Se espera un UUID; ` +
        "`app.current_company()` castea el GUC a uuid y un valor mal formado " +
        "haría fallar toda la transacción con un error de casteo, no de permisos.",
    );
  }
}
