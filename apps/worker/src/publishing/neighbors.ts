/**
 * Lo que las guardas anti-bot necesitan mirar alrededor de un post
 * (`PU-PUB-007`): los posts de **todas** las marcas del mismo dueño, cerca en
 * el tiempo, y lo que ya salió en las otras marcas con su huella.
 *
 * Igual que el auto-slot de `apps/api/src/routes/v1/calendar.ts`: la lista de
 * marcas se pide por dueño (`workspaceDirectory`) y **cada marca se lee con
 * su propio scope** (`withCompany`), así que RLS sigue aplicando marca por
 * marca y ninguna consulta cruza companies.
 *
 * La lista de marcas corre con `withoutCompany` y sin rol, como en la API: con
 * una conexión `fastgram_app` devolvería vacía (ver la cabecera de
 * `workspace-directory.ts`). En ese caso se mira sólo la marca del post, y la
 * separación entre marcas no se aplica — se loguea.
 */
import {
  contentRepository,
  postCalendar,
  postRepository,
  withCompany,
  withoutCompany,
  workspaceDirectory,
  type Database,
  type Transaction,
} from "@fastgram/db";
import type { GuardNeighbor } from "@fastgram/core";

import type { ContentFingerprinter } from "./fingerprint.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Estados que ya llegaron a la plataforma. */
export const OUT_STATUSES = ["POSTED", "IN_USER_INBOX", "UPLOADING_TO_TIKTOK"] as const;
/** Estados que no ocupan lugar: ni salieron ni van a salir solos. */
const IDLE_STATUSES = ["CANCELLED", "FAILED", "DELETED"] as const;

/** Tope de posts publicados por marca que se miran para el duplicado. */
export const DUPLICATE_SCAN_MAX_PER_BRAND = 500;

export interface NeighborDeps {
  readonly db: Database;
  readonly appRole?: string | undefined;
}

export interface NeighborQuery {
  readonly companyId: string;
  readonly nowMs: number;
  readonly horizonDays: number;
  /** Con huella propia se buscan duplicados en las otras marcas. */
  readonly fingerprinter: ContentFingerprinter | null;
  readonly wantDuplicates: boolean;
}

export interface NeighborResult {
  readonly neighbors: readonly GuardNeighbor[];
  /** `false` si la lista de marcas no se pudo leer y sólo se miró ésta. */
  readonly crossBrand: boolean;
}

export async function loadGuardNeighbors(
  deps: NeighborDeps,
  query: NeighborQuery,
): Promise<NeighborResult> {
  const scoped = <T>(
    companyId: string,
    fn: (tx: Transaction) => Promise<T>,
  ): Promise<T> =>
    withCompany(
      deps.db,
      companyId,
      fn,
      deps.appRole === undefined ? {} : { role: deps.appRole },
    );

  const owner = await scoped(query.companyId, (tx) =>
    workspaceDirectory.ownerOf(tx, query.companyId),
  );
  let brands: string[] = [query.companyId];
  let crossBrand = false;
  if (owner !== null) {
    const listed = await withoutCompany(deps.db, (tx) =>
      workspaceDirectory.list(tx, { ownerUserId: owner.ownerUserId }),
    );
    const ids = listed.map((b) => b.id);
    // Si RLS escondió las filas, la lista no trae ni a la propia marca.
    if (ids.includes(query.companyId)) {
      brands = ids;
      crossBrand = true;
    }
  }

  const fromMs = query.nowMs - 36 * HOUR_MS;
  const toMs = query.nowMs + (query.horizonDays + 2) * DAY_MS;
  const neighbors: GuardNeighbor[] = [];

  for (const brandId of brands) {
    const rows = await scoped(brandId, (tx) =>
      postCalendar.listInRange(
        tx,
        { companyId: brandId },
        { fromMs, toMs, limit: 1_000, excludeStatuses: [...IDLE_STATUSES] },
      ),
    );
    for (const row of rows) {
      neighbors.push({
        id: row.id,
        brandId,
        network: row.platform,
        atMs: (row.postedAt ?? row.scheduledAtUtc).getTime(),
        state: (OUT_STATUSES as readonly string[]).includes(row.status)
          ? "out"
          : "pending",
      });
    }

    if (
      brandId !== query.companyId &&
      query.wantDuplicates &&
      query.fingerprinter !== null
    ) {
      neighbors.push(
        ...(await publishedWithFingerprints(scoped, brandId, query.fingerprinter)),
      );
    }
  }
  return { neighbors, crossBrand };
}

/** Lo que ya salió en otra marca, con la huella de su pieza. */
async function publishedWithFingerprints(
  scoped: <T>(companyId: string, fn: (tx: Transaction) => Promise<T>) => Promise<T>,
  brandId: string,
  fingerprinter: ContentFingerprinter,
): Promise<GuardNeighbor[]> {
  const scope = { companyId: brandId };
  const posts = await scoped(brandId, async (tx) => {
    const all = [];
    let cursor: string | null = null;
    do {
      const page = await postRepository.list(tx, scope, {
        limit: 100,
        cursor,
        filter: { status: { in: [...OUT_STATUSES] } },
      });
      all.push(...page.items);
      cursor = page.hasMore ? page.cursor : null;
    } while (cursor !== null && all.length < DUPLICATE_SCAN_MAX_PER_BRAND);
    return all;
  });
  if (posts.length === 0) return [];

  const contentIds = [...new Set(posts.map((p) => p.contentId))];
  const contents = await scoped(brandId, async (tx) => {
    const found = [];
    for (let i = 0; i < contentIds.length; i += 100) {
      const page = await contentRepository.list(tx, scope, {
        limit: 100,
        includeDeleted: true,
        filter: { id: { in: contentIds.slice(i, i + 100) } },
      });
      found.push(...page.items);
    }
    return found;
  });

  const byContent = new Map<string, string | null>();
  for (const content of contents) {
    byContent.set(
      content.id,
      await fingerprinter.of({
        contentId: content.id,
        revision: content.revision,
        files: content.files,
      }),
    );
  }

  return posts.map((p) => ({
    id: p.id,
    brandId,
    network: p.platform,
    atMs: (p.postedAt ?? p.scheduledAtUtc).getTime(),
    state: "out" as const,
    fingerprint: byContent.get(p.contentId) ?? null,
  }));
}
