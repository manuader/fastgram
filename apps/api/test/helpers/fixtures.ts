/**
 * Fixtures de integración: dos workspaces con datos propios.
 *
 * La forma de los datos es lo que hace útil la suite: **cada recurso existe en los dos
 * workspaces**, así que un test de acceso cruzado siempre tiene un id real del otro
 * lado contra el que apuntar. Probar el aislamiento contra un id inventado no prueba
 * nada: un `404` por "no existe" es gratis; el que importa es el `404` sobre algo que
 * existe de verdad y es de otro.
 *
 * ## Sobre escribir con el query builder acá
 *
 * Las rutas no arman queries: usan los repositorios de `@fastgram/db`, que exigen
 * `companyId` en la firma. Este archivo sí inserta directo, y la diferencia es
 * deliberada: es **código de fixture**, no del camino de request. No hay ningún `WHERE`
 * de tenant que olvidar —el `companyId` se escribe explícito en cada fila— y el riesgo
 * que la regla evita (una ruta que filtra de menos y devuelve datos ajenos) no existe
 * en un `INSERT`. Además `withoutCompany` deja claro en el propio código cuándo se sale
 * del scope, en vez de que alguien lo note en el diff.
 */
import { randomUUID } from "node:crypto";
import {
  apiKeys,
  companies,
  connections,
  contentAngles,
  contents,
  createDb,
  influencers,
  media,
  posts,
  users,
  withoutCompany,
  type DbHandle,
} from "@fastgram/db";

import { generateApiKey } from "../../src/auth/api-keys.js";

/**
 * Base propia de esta suite: `…/fastgram` → `…/fastgram_api`.
 *
 * **Nunca la de la app.** Los fixtures arrancan con `truncate … cascade` sobre
 * `companies`, `users`, `api_keys`… Hasta el 2026-09-24 el default era
 * `…/fastgram`, la misma que usa `pnpm start`: correr `pnpm test:int` con la app
 * levantada le borraba al dueño sus marcas, sus piezas y la key de la web (la
 * web quedaba en "Access Denied"). Se deriva del `DATABASE_URL` compartido, como
 * la del worker (`_worker`), así un `DATABASE_URL` de CI arrastra la suya.
 */
export const DATABASE_URL = apiDatabaseUrl(
  process.env["DATABASE_URL"] ?? "postgres://fastgram:fastgram@localhost:5432/fastgram",
);

/** `…/fastgram` → `…/fastgram_api`. Respeta el resto de la URL tal cual. */
export function apiDatabaseUrl(shared: string): string {
  const url = new URL(shared);
  const nombre = url.pathname.replace(/^\//, "");
  if (nombre === "" || nombre.endsWith("_api")) return shared;
  url.pathname = `/${nombre}_api`;
  return url.toString();
}

/** Crea la base de la suite si falta (`CREATE DATABASE` no tiene `IF NOT EXISTS`). */
export async function ensureApiDatabase(): Promise<void> {
  const nombre = new URL(DATABASE_URL).pathname.replace(/^\//, "");
  if (!/^[a-z_][a-z0-9_]*$/.test(nombre)) {
    throw new Error(`nombre de base inválido: ${JSON.stringify(nombre)}`);
  }
  const mantenimiento = new URL(DATABASE_URL);
  mantenimiento.pathname = "/postgres";
  const admin = createDb({ url: mantenimiento.toString(), max: 1, onnotice: () => {} });
  try {
    const filas = await admin.sql`select 1 from pg_database where datname = ${nombre}`;
    if (filas.length === 0) await admin.sql.unsafe(`create database ${nombre}`);
  } finally {
    await admin.close();
  }
}

export interface SeededWorkspace {
  readonly companyId: string;
  /** Token en claro. Sólo existe acá; en la base está el hash. */
  readonly token: string;
  readonly contentId: string;
  readonly mediaId: string;
  readonly influencerId: string;
  readonly angleId: string;
  readonly postId: string;
  /**
   * La conexión OAuth del workspace.
   *
   * El fixture ya la creaba —un post necesita exactamente una cuenta, lo fuerza
   * el CHECK `posts_account_exclusive`— pero no la exponía, y sin su id no se
   * puede armar un `target` de `POST /content/:id/schedule`. Es lo que hizo que
   * esa ruta no tuviera **ningún** test de integración, y por eso su cola
   * equivocada (`"publish-post"`) sobrevivió a 82 tests verdes.
   */
  readonly connectionId: string;
}

export interface Seed {
  readonly a: SeededWorkspace;
  readonly b: SeededWorkspace;
  /** Key de `a`, revocada. FR-180: el siguiente request tiene que dar 401. */
  readonly revokedToken: string;
  /** Key de un workspace `soft_deleted`. También 401 (PRD:1867). */
  readonly softDeletedWorkspaceToken: string;
  /** Un uuid que no es de nadie, para comparar contra el 404 cruzado. */
  readonly unknownId: string;
}

export function openDb(): DbHandle {
  return createDb({ url: DATABASE_URL, max: 4, onnotice: () => {} });
}

/** Deja la base sin datos de test. Se llama antes de sembrar, no después. */
export async function truncateAll(handle: DbHandle): Promise<void> {
  // `CASCADE` + `RESTART IDENTITY` sobre las tablas que tocamos. Se listan explícitas
  // en vez de barrer el schema entero: barrerlo borraría también la tabla de
  // migraciones de Drizzle y la siguiente corrida volvería a migrar desde cero.
  //
  // `quota_ledgers` está nombrada aunque ya se vaciaba sin nombrarla: tiene FK a
  // `companies` y el `CASCADE` la arrastra —verificado contra la base, queda en 0
  // filas tras una corrida completa—. Nombrarla no cambia nada hoy y es a propósito:
  // la garantía de que la contabilidad no sobrevive entre corridas dependía de una
  // FK que nadie está mirando, y un ledger con créditos de la corrida anterior es
  // exactamente lo que hace pasar un test de "no alcanzan los créditos" sin que
  // pruebe nada.
  await handle.sql`
    truncate table
      posts, contents, media, influencers, content_angles, connections,
      api_keys, workspace_memberships, quota_ledgers, companies, users
    restart identity cascade
  `;
}

async function seedWorkspace(
  handle: DbHandle,
  ownerUserId: string,
  name: string,
  status: "active" | "soft_deleted" = "active",
): Promise<{
  companyId: string;
  token: string;
  ids: Omit<SeededWorkspace, "companyId" | "token">;
}> {
  return withoutCompany(handle.db, async (tx) => {
    const [company] = await tx
      .insert(companies)
      .values({
        name,
        ownerUserId,
        status,
        planId: "growth",
        billingAnchorDay: 1,
        timezone: "UTC",
      })
      .returning({ id: companies.id });
    if (company === undefined) throw new Error("no se creó la company");
    const companyId = company.id;

    const key = generateApiKey();
    await tx.insert(apiKeys).values({
      companyId,
      label: `key de ${name}`,
      // Se guarda SOLO el hash. El token en claro vive en memoria del test.
      hash: key.hash,
      kind: "workspace",
    });

    const [content] = await tx
      .insert(contents)
      .values({ companyId, type: "slideshow", status: "CREATED" })
      .returning({ id: contents.id });

    const [asset] = await tx
      .insert(media)
      .values({
        companyId,
        mediaType: "image",
        filename: `${name}.png`,
        r2Url: `https://cdn.example.test/${name}.png`,
        storageKey: `media/${companyId}/${name}.png`,
        sizeMb: 1.5,
        origin: "manual_upload",
      })
      .returning({ id: media.mediaId });

    const [influencer] = await tx
      .insert(influencers)
      .values({
        companyId,
        name: `influencer de ${name}`,
        gender: "woman",
        age: 27,
        ethnicity: "latina",
      })
      .returning({ id: influencers.id });

    const [angle] = await tx
      .insert(contentAngles)
      .values({
        companyId,
        title: `ángulo de ${name}`,
        description: "descripción",
        targetAudience: "audiencia",
      })
      .returning({ id: contentAngles.id });

    if (content === undefined) throw new Error("no se creó el content");

    // Un post necesita **exactamente una** cuenta: el schema lo fuerza con
    // `posts_account_exclusive` (`num_nonnulls(connectionId, warmedAccountId) = 1`) y
    // además exige que `accountType` coincida con la columna poblada
    // (`posts_account_type_matches`). Por eso el fixture crea la conexión: un post
    // huérfano no es un caso que la base permita, así que tampoco sirve para probar.
    const [connection] = await tx
      .insert(connections)
      .values({
        companyId,
        platform: "tiktok",
        platformUserId: `tt-${name}`,
        platformUsername: name,
        scopes: ["video.publish"],
        publishable: true,
      })
      .returning({ id: connections.id });
    if (connection === undefined) throw new Error("no se creó la connection");

    const [post] = await tx
      .insert(posts)
      .values({
        companyId,
        contentId: content.id,
        platform: "tiktok",
        accountType: "oauth",
        connectionId: connection.id,
        scheduledAtUtc: new Date("2026-10-01T12:00:00.000Z"),
        status: "SCHEDULED",
      })
      .returning({ id: posts.id });

    if (
      asset === undefined ||
      influencer === undefined ||
      angle === undefined ||
      post === undefined
    ) {
      throw new Error("faltó sembrar alguna fila");
    }

    return {
      companyId,
      token: key.token,
      ids: {
        contentId: content.id,
        mediaId: asset.id,
        influencerId: influencer.id,
        angleId: angle.id,
        postId: post.id,
        connectionId: connection.id,
      },
    };
  });
}

export async function seed(handle: DbHandle): Promise<Seed> {
  await truncateAll(handle);

  const ownerUserId = await withoutCompany(handle.db, async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        externalIdentityId: `ext-${randomUUID()}`,
        email: `owner-${randomUUID()}@example.test`,
        fullName: "Owner de prueba",
        timezone: "UTC",
      })
      .returning({ id: users.id });
    if (user === undefined) throw new Error("no se creó el user");
    return user.id;
  });

  const a = await seedWorkspace(handle, ownerUserId, "acme");
  const b = await seedWorkspace(handle, ownerUserId, "globex");
  const deleted = await seedWorkspace(handle, ownerUserId, "borrado", "soft_deleted");

  // Una key más para `a`, revocada.
  const revoked = generateApiKey();
  await withoutCompany(handle.db, (tx) =>
    tx.insert(apiKeys).values({
      companyId: a.companyId,
      label: "key revocada",
      hash: revoked.hash,
      kind: "workspace",
      revokedAt: new Date("2026-01-01T00:00:00.000Z"),
    }),
  );

  return {
    a: { companyId: a.companyId, token: a.token, ...a.ids },
    b: { companyId: b.companyId, token: b.token, ...b.ids },
    revokedToken: revoked.token,
    softDeletedWorkspaceToken: deleted.token,
    unknownId: randomUUID(),
  };
}

export const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
});
