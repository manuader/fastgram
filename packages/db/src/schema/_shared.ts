/**
 * Piezas compartidas por todos los archivos de schema.
 *
 * ## Traducciones Convex → Postgres (documentadas una sola vez, aplican a todo el schema)
 *
 * 1. **`_id` → `id` (uuid).** El PRD describe los ids como *"valid Convex document ids"*.
 *    Convex no existe acá (ADR-003). Donde el PRD nombra el campo explícitamente
 *    (`mediaId`, `audioId`, `warmedAccountId`, `uploadId`, `key`) se respeta ese nombre
 *    literal porque sale del contrato público de la API; donde dice `_id`, es `id`.
 *
 * 2. **`ms epoch` → `timestamptz`.** El PRD tipa las fechas como milisegundos desde epoch,
 *    que es cómo Convex las serializa. En Postgres eso rompería los índices
 *    `(companyId, createdAt)` y la paginación por cursor. Se guarda `timestamptz` y la
 *    serialización a ms es trabajo de la capa de contrato (`packages/contracts`).
 *
 * 3. **`createdAt` / `updatedAt` transversales.**
 *    NO ESTÁ EN EL PRD: varias entidades (`CompanyProfile`, `BlitzPreferences`,
 *    `Media`, `QuotaLedger`, `Content`, …) no listan uno u otro. Se agregan a todas las
 *    tablas porque el índice `(companyId, createdAt)` de IMPL §5 punto 6 y el cursor
 *    estable de PRD §9.10 necesitan una columna de tiempo monótona y uniforme. Donde el
 *    PRD ya define una fecha de negocio con otro nombre (`uploadedAt`, `fetchedAt`,
 *    `capturedAt`, `computedAt`) esa columna se conserva tal cual: es la que va al
 *    contrato; `createdAt` es la de la fila.
 */

import { timestamp } from "drizzle-orm/pg-core";

/** `timestamptz` con `Date` en TypeScript. Ver traducción (2) arriba. */
export const tsColumn = () => timestamp({ withTimezone: true, mode: "date" });

/**
 * Par `createdAt`/`updatedAt`. Es una función y no un objeto constante a propósito:
 * spreadear la MISMA instancia de builder en dos tablas es una fuente conocida de
 * estado compartido entre tablas.
 */
export const timestamps = () => ({
  createdAt: tsColumn().notNull().defaultNow(),
  updatedAt: tsColumn().notNull().defaultNow(),
});

/** Sólo `createdAt`: para las entidades que el PRD declara inmutables (append-only). */
export const createdAtOnly = () => ({
  createdAt: tsColumn().notNull().defaultNow(),
});

/**
 * Soft-delete transversal (P1-DATA-012 · PRD §9.4).
 * `null` = viva. Todo listado la excluye por defecto; eso lo garantizan los
 * repositorios, no la base.
 */
export const softDelete = () => ({
  deletedAt: tsColumn(),
});
