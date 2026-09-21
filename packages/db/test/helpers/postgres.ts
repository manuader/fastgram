/**
 * Postgres real para los tests de integración.
 *
 * Imagen `pgvector/pgvector:pg17`: la misma de `docker-compose.yml`. No es un detalle
 * cosmético — `0001_extensions.sql` hace `CREATE EXTENSION vector`, que en la imagen
 * `postgres` pelada falla, y el test de migraciones dejaría de significar nada si
 * corriera contra una imagen distinta a la de desarrollo.
 */

import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { createDb, type Database, type DbHandle } from "../../src/client";
import { applyMigrations } from "../../src/migrate";
import { APP_ROLE } from "../../src/tenancy";
import { companies, users } from "../../src/schema/index";

export const TEST_IMAGE = "pgvector/pgvector:pg17";

export interface TestDatabase {
  readonly container: StartedPostgreSqlContainer;
  readonly handle: DbHandle;
  readonly db: Database;
  stop(): Promise<void>;
}

/** Levanta un Postgres limpio y aplica **todas** las migraciones. */
export async function startTestDatabase(): Promise<TestDatabase> {
  const container = await new PostgreSqlContainer(TEST_IMAGE).start();
  const handle = createDb({
    url: container.getConnectionUri(),
    max: 5,
    // Los `NOTICE` de `CREATE EXTENSION IF NOT EXISTS` ensucian la salida del test.
    onnotice: () => {},
  });
  await applyMigrations(handle.db);

  return {
    container,
    handle,
    db: handle.db,
    async stop() {
      await handle.close();
      await container.stop();
    },
  };
}

export interface SeededCompany {
  readonly companyId: string;
  readonly ownerUserId: string;
}

/**
 * Crea un `User` y su `Company`.
 *
 * Se hace **sin** `SET ROLE` (o sea, como superusuario) a propósito: es el camino de
 * provisión, no el de la aplicación. Todo lo que los tests quieran verificar sobre
 * aislamiento tiene que pasar después por `withCompany(..., { role: APP_ROLE })`.
 */
export async function seedCompany(
  db: Database,
  overrides: { readonly name?: string } = {},
): Promise<SeededCompany> {
  const userId = randomUUID();
  const companyId = randomUUID();
  const suffix = userId.slice(0, 8);

  await db.insert(users).values({
    id: userId,
    externalIdentityId: `ext_${suffix}`,
    email: `owner+${suffix}@example.test`,
    fullName: `Owner ${suffix}`,
    timezone: "UTC",
  });

  await db.insert(companies).values({
    id: companyId,
    name: overrides.name ?? `Company ${suffix}`,
    ownerUserId: userId,
    planId: "free",
    billingAnchorDay: 1,
    timezone: "UTC",
    status: "active",
  });

  await db
    .update(users)
    .set({ defaultWorkspaceId: companyId })
    .where(eq(users.id, userId));

  return { companyId, ownerUserId: userId };
}

export { APP_ROLE };
