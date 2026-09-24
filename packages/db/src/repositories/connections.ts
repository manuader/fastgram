/**
 * Conexiones OAuth por marca — `PU-PUB-001`, `PU-PUB-002`, `P3-OAUTH-008`.
 *
 * Todo con `TenantScope`. `accessToken` / `refreshToken` entran y salen como
 * **ciphertext**: el cifrado es de `packages/adapters/src/crypto` y ningún
 * método de acá lo ve en claro.
 *
 * {@link connectionTokenStore} implementa el puerto `ConnectionTokenStore`
 * (`@fastgram/ports`) sobre un `Executor`: es lo que el worker le pasa a
 * `resolveAccessToken` (`@fastgram/core`) dentro de una transacción.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type {
  ConnectionTokenStore,
  ConnectionTokenUpdate,
  StoredConnectionTokens,
} from "@fastgram/ports";

import type { Executor } from "../client.js";
import { connections } from "../schema/index.js";
import type { TenantScope } from "./base.js";

export type ConnectionRow = typeof connections.$inferSelect;
export type ConnectionPlatformValue = ConnectionRow["platform"];

export interface ConnectionAccountValues {
  readonly platform: ConnectionPlatformValue;
  readonly platformUserId: string;
  readonly platformUsername: string;
  readonly displayName: string | null;
  readonly avatarUrl: string | null;
  readonly scopes: readonly string[];
  readonly publishable: boolean;
  /** Ciphertext. */
  readonly accessToken: string;
  /** Ciphertext. */
  readonly refreshToken: string | null;
  readonly tokenExpiry: Date | null;
  readonly refreshTokenExpiry: Date | null;
  readonly tokenIssuedAt: Date;
}

export const connectionAccountRepository = {
  /** Las de la marca, en orden de alta. Una marca tiene pocas: sin paginar. */
  async list(exec: Executor, scope: TenantScope): Promise<ConnectionRow[]> {
    return exec
      .select()
      .from(connections)
      .where(eq(connections.companyId, scope.companyId))
      .orderBy(asc(connections.createdAt), asc(connections.id))
      .limit(200);
  },

  async find(
    exec: Executor,
    scope: TenantScope,
    id: string,
  ): Promise<ConnectionRow | null> {
    const rows = await exec
      .select()
      .from(connections)
      .where(and(eq(connections.id, id), eq(connections.companyId, scope.companyId)))
      .limit(1);
    return rows[0] ?? null;
  },

  /**
   * Alta o reconexión de una cuenta: por `(marca, plataforma, id en la
   * plataforma)`. Reconectar la vuelve `active`, pisa los tokens y limpia el
   * motivo del estado anterior. `created_at` no cambia (la fila es la misma).
   */
  async upsertAccount(
    exec: Executor,
    scope: TenantScope,
    values: ConnectionAccountValues,
  ): Promise<ConnectionRow> {
    const set = {
      platformUsername: values.platformUsername,
      displayName: values.displayName,
      avatarUrl: values.avatarUrl,
      scopes: [...values.scopes],
      publishable: values.publishable,
      accessToken: values.accessToken,
      refreshToken: values.refreshToken,
      tokenExpiry: values.tokenExpiry,
      refreshTokenExpiry: values.refreshTokenExpiry,
      tokenIssuedAt: values.tokenIssuedAt,
      status: "active" as const,
      statusReason: null,
      updatedAt: new Date(),
    };
    const rows = await exec
      .insert(connections)
      .values({
        ...set,
        companyId: scope.companyId,
        platform: values.platform,
        platformUserId: values.platformUserId,
      })
      .onConflictDoUpdate({
        target: [connections.companyId, connections.platform, connections.platformUserId],
        set,
      })
      .returning();
    const row = rows[0];
    if (row === undefined) throw new Error("El upsert de la conexión no devolvió fila.");
    return row;
  },

  /**
   * Desconectar: `revoked` y **sin tokens**. No se borra la fila: los posts
   * la referencian y `posts_account_exclusive` impide dejarlos sin cuenta.
   */
  async revoke(
    exec: Executor,
    scope: TenantScope,
    id: string,
  ): Promise<ConnectionRow | null> {
    const rows = await exec
      .update(connections)
      .set({
        status: "revoked",
        statusReason: "disconnected",
        accessToken: null,
        refreshToken: null,
        publishable: false,
        updatedAt: new Date(),
      })
      .where(and(eq(connections.id, id), eq(connections.companyId, scope.companyId)))
      .returning();
    return rows[0] ?? null;
  },

  async markExpired(
    exec: Executor,
    scope: TenantScope,
    id: string,
    reason: string,
  ): Promise<void> {
    await exec
      .update(connections)
      .set({
        status: "expired",
        statusReason: reason,
        publishable: false,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(connections.id, id),
          eq(connections.companyId, scope.companyId),
          eq(connections.status, "active"),
        ),
      );
  },
};

function toStored(row: ConnectionRow): StoredConnectionTokens {
  return {
    id: row.id,
    companyId: row.companyId,
    platform: row.platform,
    status: row.status,
    accessToken: row.accessToken,
    refreshToken: row.refreshToken,
    tokenExpiry: row.tokenExpiry,
    refreshTokenExpiry: row.refreshTokenExpiry,
    tokenIssuedAt: row.tokenIssuedAt,
  };
}

/**
 * El puerto `ConnectionTokenStore` sobre un `Executor`. Para que el
 * `FOR UPDATE` de `load` sirva, `exec` tiene que ser una transacción (fuera
 * de una, el lock dura lo que la sentencia).
 */
export function connectionTokenStore(exec: Executor): ConnectionTokenStore {
  return {
    async load(companyId, connectionId) {
      const rows = await exec
        .select()
        .from(connections)
        .where(
          and(eq(connections.id, connectionId), eq(connections.companyId, companyId)),
        )
        .limit(1)
        .for("update");
      const row = rows[0];
      return row === undefined ? null : toStored(row);
    },
    async saveTokens(companyId, connectionId, update: ConnectionTokenUpdate) {
      await exec
        .update(connections)
        .set({
          accessToken: update.accessToken,
          ...(update.refreshToken === undefined
            ? {}
            : { refreshToken: update.refreshToken }),
          tokenExpiry: update.tokenExpiry,
          ...(update.refreshTokenExpiry === undefined
            ? {}
            : { refreshTokenExpiry: update.refreshTokenExpiry }),
          tokenIssuedAt: update.tokenIssuedAt,
          updatedAt: sql`now()`,
        })
        .where(
          and(eq(connections.id, connectionId), eq(connections.companyId, companyId)),
        );
    },
    async markExpired(companyId, connectionId, reason) {
      await connectionAccountRepository.markExpired(
        exec,
        { companyId },
        connectionId,
        reason,
      );
    },
  };
}
