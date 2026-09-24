/**
 * Base de los extractores que traen **perfil y posts en una sola llamada**.
 *
 * El puerto separa `readProfile` y `readRecentContent`, y el handler del worker
 * los llama uno detrás del otro. Contra Instagram anónimo eso sería **dos**
 * lecturas por alta, y cada lectura de más es un 429 más cerca (issue #2726 de
 * instaloader). Así que la subclase trae todo junto y esta base lo memoiza un
 * rato corto por handle: la segunda llamada del handler sale de memoria, y dos
 * análisis simultáneos del mismo handle comparten la promesa.
 *
 * El memo es **por instancia y en memoria**: no es un cache de producto (ése,
 * si hace falta, vive en el extractor), sólo evita duplicar la misma lectura
 * dentro de un análisis.
 */
import {
  PortError,
  type BrandSourceType,
  type ReadContentRequest,
  type ReadProfileRequest,
  type ResolvedSocialSource,
  type ResolveSourceRequest,
  type SocialContentItem,
  type SocialProfileSignals,
  type SocialReadCapabilities,
  type SocialReader,
  type SocialReadOutcome,
} from "@fastgram/ports";

import { handleFrom, type ScrapedPlatform } from "./handles.js";

export interface Bundle {
  readonly profile: SocialProfileSignals;
  /** Del más reciente al más viejo. */
  readonly items: readonly SocialContentItem[];
  /** La lista de posts se cortó después de leer el perfil. */
  readonly itemsFailed: boolean;
}

export type BundleOutcome = SocialReadOutcome<Bundle>;

interface MemoEntry {
  readonly at: number;
  readonly promise: Promise<BundleOutcome>;
}

export interface BundleReaderOptions {
  /** Cuántos ítems pedir de una vez. Techo: `maxContentItems` de la subclase. */
  readonly contentLimit: number;
  /** Vida del memo. Default 60 s. */
  readonly memoTtlMs?: number;
  readonly now?: () => number;
}

export abstract class BundleSocialReader implements SocialReader {
  abstract readonly source: BrandSourceType;
  protected abstract readonly platform: ScrapedPlatform;
  protected abstract readonly errorSource: string;

  readonly #memo = new Map<string, MemoEntry>();
  readonly #ttl: number;
  readonly #now: () => number;
  protected readonly contentLimit: number;

  constructor(options: BundleReaderOptions) {
    if (!Number.isInteger(options.contentLimit) || options.contentLimit < 1) {
      throw new Error(
        `contentLimit tiene que ser un entero >= 1 (vino ${String(options.contentLimit)})`,
      );
    }
    this.contentLimit = options.contentLimit;
    this.#ttl = options.memoTtlMs ?? 60_000;
    this.#now = options.now ?? Date.now;
  }

  abstract capabilities(): SocialReadCapabilities;

  /** Una lectura real. `handle` ya validado. */
  protected abstract fetchBundle(handle: string, limit: number): Promise<BundleOutcome>;

  protected handleOf(input: string): string {
    const handle = handleFrom(this.platform, input);
    if (handle === null) {
      throw new PortError("bad_request", `Not a ${this.platform} profile.`, {
        source: this.errorSource,
      });
    }
    return handle;
  }

  protected bundle(handle: string): Promise<BundleOutcome> {
    const now = this.#now();
    const hit = this.#memo.get(handle);
    if (hit !== undefined && now - hit.at < this.#ttl) return hit.promise;
    const promise = this.fetchBundle(handle, this.contentLimit);
    this.#memo.set(handle, { at: now, promise });
    // Una falla no se memoiza: el reintento del job tiene que volver a intentar.
    promise.catch(() => {
      if (this.#memo.get(handle)?.promise === promise) this.#memo.delete(handle);
    });
    return promise;
  }

  async resolve(
    request: ResolveSourceRequest,
  ): Promise<SocialReadOutcome<ResolvedSocialSource>> {
    const handle = this.handleOf(request.input);
    const read = await this.bundle(handle);
    if (read.status !== "ok") return read;
    const p = read.data.profile;
    return {
      status: "ok",
      tier: read.tier,
      data: {
        sourceType: this.source,
        handle,
        canonicalUrl: this.canonicalUrl(handle),
        available: true,
        ...(p.displayName === undefined ? {} : { displayName: p.displayName }),
        ...(p.avatarUrl === undefined ? {} : { avatarUrl: p.avatarUrl }),
      },
    };
  }

  protected abstract canonicalUrl(handle: string): string;

  async readProfile(
    request: ReadProfileRequest,
  ): Promise<SocialReadOutcome<SocialProfileSignals>> {
    const read = await this.bundle(this.handleOf(request.handle));
    if (read.status !== "ok") return read;
    return { status: "ok", tier: read.tier, data: read.data.profile };
  }

  async readRecentContent(
    request: ReadContentRequest,
  ): Promise<SocialReadOutcome<readonly SocialContentItem[]>> {
    const read = await this.bundle(this.handleOf(request.handle));
    if (read.status !== "ok") return read;
    const limit = Math.max(
      0,
      Math.min(request.limit ?? this.contentLimit, this.contentLimit),
    );
    const items = read.data.items.slice(0, limit);
    if (items.length === 0 && read.data.itemsFailed) {
      // Hay perfil pero no posts: el handler lo marca `partial` (`FR-011.8`).
      return { status: "insufficient_content", attemptedTiers: [read.tier] };
    }
    return { status: "ok", tier: read.tier, data: items };
  }
}
