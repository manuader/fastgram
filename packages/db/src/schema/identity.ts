/**
 * Identidad y tenencia — `DATA-001` User, `DATA-002` Company (Workspace),
 * `DATA-003` WorkspaceMembership.
 *
 * `companies` es la raíz de la tenencia: todo lo demás cuelga de acá y RLS compara
 * contra `app.current_company()` (IMPL §2.4).
 */

import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { createdAtOnly, timestamps, tsColumn } from "./_shared.js";
import {
  companyStatusEnum,
  membershipRoleEnum,
  membershipStatusEnum,
  subscriptionStatusEnum,
  userDeletionStatusEnum,
} from "./enums.js";

/**
 * DATA-001 — `User`. **Global, no workspace-scoped**: un usuario pertenece a N
 * workspaces vía `WorkspaceMembership`. Por eso no lleva `companyId` ni política RLS
 * por compañía (ver `drizzle/0002_tenancy_rls.sql`).
 */
export const users = pgTable(
  "users",
  {
    id: uuid().primaryKey().defaultRandom(),
    /**
     * El PRD llama a este campo `clerkUserId` (DATA-001) porque el original usa Clerk,
     * pero §9.1 dice explícitamente *"El clon puede usar Clerk o equivalente"* y
     * **ADR-008 descarta Clerk** en favor de Better Auth self-hosted. Dejar el nombre de
     * un proveedor rechazado en una columna es una trampa para el próximo que lea esto.
     * DESVIACIÓN DEL PRD: `clerkUserId` → `externalIdentityId`. No es un campo del
     * contrato público (User no se expone en la API v1), así que no rompe integradores.
     *
     * **Nullable desde `0011`** (`P1-AUTH-001`): con Better Auth el id del usuario en el
     * proveedor **es** `users.id` — Better Auth escribe en esta misma tabla — y nunca
     * llena esta columna. Queda para el día que ADR-008 vuelva a un proveedor alojado.
     */
    externalIdentityId: text(),
    email: text().notNull(),
    /** Lo escribe Better Auth (`emailVerified`). `0011`. */
    emailVerified: boolean().notNull().default(false),
    /** El `image` de Better Auth. `0011`. */
    image: text(),
    fullName: text().notNull(),
    /** IANA. El PRD dice *"sincronizada automáticamente"*. */
    timezone: text().notNull(),
    defaultWorkspaceId: uuid().references((): AnyPgColumn => companies.id, {
      onDelete: "set null",
    }),
    deletionStatus: userDeletionStatusEnum().notNull().default("none"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("users_email_uq").on(t.email),
    uniqueIndex("users_external_identity_uq").on(t.externalIdentityId),
    /** DATA-001: *"validación ≥ 2 caracteres"*. */
    check("users_full_name_min_len", sql`char_length(${t.fullName}) >= 2`),
  ],
);

/**
 * DATA-002 — `Company` (Workspace). Es el scope de todo el resto del modelo.
 */
export const companies = pgTable(
  "companies",
  {
    id: uuid().primaryKey().defaultRandom(),
    name: text().notNull(),
    /**
     * *"único global cuando existe"* (`This website is already registered.`). La
     * EXTENSION lo vuelve opcional: un workspace puede derivar su identidad de una
     * `BrandSource` social. Unicidad por índice parcial, no por `unique`, para que
     * varios `NULL` convivan.
     */
    websiteUrl: text(),
    /**
     * `ref? → BrandSource` (EXTENSION). **Sin FOREIGN KEY a propósito**: `brand_sources`
     * referencia a `companies`, y declarar la vuelta crearía un ciclo entre los módulos
     * de schema que ESM resuelve mal. La integridad la sostiene el repositorio, que sólo
     * acepta una fuente del mismo `companyId`.
     */
    primaryBrandSourceId: uuid(),
    logoUrl: text(),
    ownerUserId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    status: companyStatusEnum().notNull().default("draft"),
    /**
     * `ref → Plan`. El PRD **no define una entidad `Plan`** en §8 (los planes viven en
     * §16.1 como catálogo de producto). Se guarda el identificador de plan como texto en
     * vez de inventar una tabla que el PRD no especifica.
     */
    planId: text().notNull(),
    subscriptionStatus: subscriptionStatusEnum().notNull().default("trialing"),
    /** Día de reset de saves incluidos (PRD §16.2: *"día ancla de facturación"*). */
    billingAnchorDay: integer().notNull(),
    timezone: text().notNull(),
    /** Lista abierta — ver `KNOWN_ENTITLEMENTS`. */
    entitlements: text()
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    apiOverageEnabled: boolean().notNull().default(false),
    /**
     * `ref? → Partner`. Igual que `planId`: el PRD nombra `Partner` (§9.7) pero no lo
     * define como entidad en §8. Sin tabla, sin FK.
     */
    partnerId: uuid(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("companies_website_url_uq")
      .on(t.websiteUrl)
      .where(sql`${t.websiteUrl} is not null`),
    index("companies_owner_created_idx").on(t.ownerUserId, t.createdAt),
  ],
);

/**
 * DATA-003 — `WorkspaceMembership` (INFERRED en el PRD).
 * El PRD no lista `updatedAt` acá; se agrega por la convención transversal de
 * `_shared.ts`.
 */
export const workspaceMemberships = pgTable(
  "workspace_memberships",
  {
    id: uuid().primaryKey().defaultRandom(),
    companyId: uuid()
      .notNull()
      .references(() => companies.id, { onDelete: "cascade" }),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: membershipRoleEnum().notNull(),
    invitedBy: uuid().references(() => users.id, { onDelete: "set null" }),
    status: membershipStatusEnum().notNull().default("invited"),
    ...createdAtOnly(),
  },
  (t) => [
    index("workspace_memberships_company_created_idx").on(t.companyId, t.createdAt),
    uniqueIndex("workspace_memberships_company_user_uq").on(t.companyId, t.userId),
    index("workspace_memberships_user_idx").on(t.userId),
  ],
);

/**
 * Referencia a `companies` reutilizable. Está acá y no en `_shared.ts` porque
 * `_shared.ts` no puede importar tablas sin crear un ciclo.
 */
export const companyRef = () =>
  uuid()
    .notNull()
    .references(() => companies.id, { onDelete: "cascade" });

/**
 * Tablas de Better Auth — `P1-AUTH-001`, IMPL ADR-008, `drizzle/0011_better_auth_identity.sql`.
 *
 * El modelo `user` de Better Auth **es** `users` (mapeado desde el adaptador); estas son
 * las otras tres. Globales como `users`: una sesión o una credencial no son de un
 * workspace. Las escribe y lee Better Auth vía `pg`, no los repositorios de este
 * paquete: están acá para que el schema de Drizzle no mienta sobre lo que hay en la
 * base, y para que el test de migraciones las cuente.
 *
 * `user_id` con `ON DELETE CASCADE`: borrar el usuario se lleva sesiones y credenciales
 * en la misma sentencia (§9.1, borrado verificado sin estados intermedios).
 */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: uuid().primaryKey().defaultRandom(),
    /** Credencial. En la cookie viaja **firmado** con el secreto de Better Auth. */
    token: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: tsColumn().notNull(),
    ipAddress: text(),
    userAgent: text(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("auth_sessions_token_uq").on(t.token),
    index("auth_sessions_user_idx").on(t.userId),
  ],
);

export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: uuid().primaryKey().defaultRandom(),
    accountId: text().notNull(),
    /** `credential` para email/password; el id del proveedor para SSO. */
    providerId: text().notNull(),
    userId: uuid()
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Tokens del proveedor de SSO. `NFR-007`: nunca suben por el puerto. */
    accessToken: text(),
    refreshToken: text(),
    idToken: text(),
    accessTokenExpiresAt: tsColumn(),
    refreshTokenExpiresAt: tsColumn(),
    scope: text(),
    /** Hash de la contraseña (cuentas `credential`). */
    password: text(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("auth_accounts_provider_account_uq").on(t.providerId, t.accountId),
    index("auth_accounts_user_idx").on(t.userId),
  ],
);

export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: uuid().primaryKey().defaultRandom(),
    identifier: text().notNull(),
    value: text().notNull(),
    expiresAt: tsColumn().notNull(),
    ...timestamps(),
  },
  (t) => [index("auth_verifications_identifier_idx").on(t.identifier)],
);
