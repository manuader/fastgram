/**
 * `@fastgram/db` — schema Drizzle, migraciones y repositorios (ADR-004).
 *
 * Dos reglas que valen para todo lo que sale de acá:
 *  1. Ningún acceso a datos de cliente sin `companyId` en la firma (IMPL §2.4).
 *  2. El acceso cruzado devuelve `null`; el `404` lo traduce la capa de arriba.
 */

export * as schema from "./schema/index";
export * from "./schema/index";

export { createDb } from "./client";
export type {
  CreateDbOptions,
  Database,
  DbHandle,
  Executor,
  Schema,
  Transaction,
} from "./client";

export {
  APP_ROLE,
  CURRENT_COMPANY_SETTING,
  withCompany,
  withoutCompany,
} from "./tenancy";
export type { WithCompanyOptions } from "./tenancy";

export {
  buildPage,
  cursorCondition,
  cursorOrderBy,
  decodeCursor,
  encodeCursor,
  fetchLimit,
  InvalidCursorError,
  normalizeLimit,
} from "./pagination";
export type { CursorKey, Page, PageRequest, SortDirection } from "./pagination";

export * from "./repositories/index";

export * from "./limits";

export { applyMigrations, migrateWithUrl, MIGRATIONS_FOLDER } from "./migrate";
