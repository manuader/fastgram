-- Tablas de Better Auth sobre `users` — `P1-AUTH-001`, IMPL ADR-008, PRD §9.1.
--
-- ## Una sola tabla de usuarios
--
-- Better Auth necesita cuatro modelos: user, session, account y verification.
-- `user` **no** es una tabla nueva: se mapea a `users` (DATA-001) con
-- `modelName`/`fields` desde el adaptador (`BetterAuthIdentity`). Una segunda
-- tabla de usuarios obligaría a sincronizar dos filas por persona, y la
-- sincronización a medias es exactamente el fallo de §9.1 («un borrado a medias
-- deja al usuario sin poder entrar y sin poder irse»).
--
-- Consecuencia: `IdentityUserId` (el id que devuelve el puerto) **es**
-- `users.id`. No hay tabla de correspondencia.
--
-- ## Lo que cambia en `users`
--
--  - `email_verified` — Better Auth lo escribe siempre. `DEFAULT false` para que
--    las filas existentes (y los fixtures que insertan sin él) sigan valiendo.
--  - `image` — el `image` de Better Auth. Nullable.
--  - `external_identity_id` pasa a **nullable**. Existía para guardar el id del
--    usuario en un proveedor externo (era `clerkUserId`). Con Better Auth ese id
--    es la propia fila, y Better Auth nunca escribe la columna: con `NOT NULL`
--    sin default, **todo alta fallaría** — el chequeo de esquema de Better Auth
--    lo reporta como `unexpected-required-column`. Queda para el día que ADR-008
--    se revierta a un proveedor alojado; el índice único se mantiene (en
--    Postgres los NULL no chocan entre sí).
--
-- `timezone` sigue `NOT NULL` sin default de base: el adaptador la declara como
-- campo adicional con default `UTC`, así que Better Auth la escribe siempre.
-- `full_name` conserva su CHECK de ≥ 2 caracteres (DATA-001); el adaptador lo
-- valida antes para devolver `bad_request` y no un error de restricción.
--
-- ## Tablas nuevas, con prefijo `auth_`
--
-- `accounts` a secas se confundiría con `warmed_accounts` y con las cuentas
-- sociales de `connections`, que son otra cosa (§10 regla 7: el OAuth de
-- plataforma no es identidad). El prefijo deja claro de quién son.
--
-- Ids `uuid` como el resto del modelo: el adaptador configura
-- `generateId: "uuid"`. `user_id` es `uuid` con FK a `users(id)` **ON DELETE
-- CASCADE**: borrar la fila del usuario se lleva sesiones y credenciales en la
-- **misma sentencia**, que es lo que hace atómico a `deleteUser`.
--
-- ## RLS y permisos
--
-- Son tablas **globales**, como `users`: una sesión o una credencial no
-- pertenecen a un workspace (un usuario tiene N). Sin política por compañía, y
-- listadas en `NON_TENANT_TABLES` con su razón. `fastgram_app` ya las recibiría
-- por el `ALTER DEFAULT PRIVILEGES` de `0002` si esta migración corre con el
-- mismo dueño; el GRANT explícito es para no depender de eso (trampa 17: un
-- grant que no aplica no falla, simplemente no está). Sólo DML: no hay
-- secuencias (ids uuid), así que no se otorga nada sobre secuencias.
--
-- `auth_sessions.token` y `auth_accounts.password` (hash) son credenciales.
-- Better Auth guarda el token de sesión **en claro**; lo que viaja en la
-- cookie es ese token **firmado** con `BETTER_AUTH_SECRET`, así que una lectura
-- de esta tabla sin el secreto no alcanza para forjar una cookie válida.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "email_verified" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "image" text;
--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "external_identity_id" DROP NOT NULL;
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token" text NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "auth_sessions_token_uq" ON "auth_sessions" USING btree ("token");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "auth_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" uuid NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
-- Una identidad externa (o la credencial de un usuario) se vincula a un solo
-- usuario. Better Auth la busca por este par (`findAccountByKey`).
CREATE UNIQUE INDEX IF NOT EXISTS "auth_accounts_provider_account_uq" ON "auth_accounts" USING btree ("provider_id", "account_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_accounts_user_idx" ON "auth_accounts" USING btree ("user_id");
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "auth_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "auth_verifications_identifier_idx" ON "auth_verifications" USING btree ("identifier");
--> statement-breakpoint

GRANT SELECT, INSERT, UPDATE, DELETE ON "auth_sessions", "auth_accounts", "auth_verifications" TO "fastgram_app";
