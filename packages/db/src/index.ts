/**
 * `@fastgram/db` — schema Drizzle, migraciones y repositorios (ADR-004).
 *
 * Dos reglas que valen para todo lo que sale de acá:
 *  1. Ningún acceso a datos de cliente sin `companyId` en la firma (IMPL §2.4).
 *  2. El acceso cruzado devuelve `null`; el `404` lo traduce la capa de arriba.
 */

export * as schema from "./schema/index.js";
export * from "./schema/index.js";

export { createDb } from "./client.js";
export type {
  CreateDbOptions,
  Database,
  DbHandle,
  Executor,
  Schema,
  Transaction,
} from "./client.js";

export {
  APP_ROLE,
  CURRENT_COMPANY_SETTING,
  withCompany,
  withoutCompany,
} from "./tenancy.js";
export type { WithCompanyOptions } from "./tenancy.js";

export {
  buildPage,
  cursorCondition,
  cursorOrderBy,
  decodeCursor,
  encodeCursor,
  fetchLimit,
  InvalidCursorError,
  normalizeLimit,
} from "./pagination.js";
export type { CursorKey, Page, PageRequest, SortDirection } from "./pagination.js";

export * from "./repositories/index.js";

export * from "./limits.js";

export { applyMigrations, migrateWithUrl, MIGRATIONS_FOLDER } from "./migrate.js";
