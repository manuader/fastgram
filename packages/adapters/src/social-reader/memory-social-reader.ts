/**
 * `SocialReader` en memoria — PRD `INT-014`, `FR-011`, §9.14, §19.5.1.
 *
 * **No lee ninguna plataforma.** Los perfiles se siembran en el constructor.
 * Lo que este adaptador implementa de verdad es el **control de flujo** de
 * `FR-011`, que es la parte del puerto que no depende de con qué se lea:
 *
 * 1. **Nada bloquea el alta** (§19.5.1). `not_found`, `private` e
 *    `insufficient_content` son *resultados*, no excepciones. Un adaptador que
 *    lanzara donde el contrato promete un resultado rompe la escalera
 *    `B → C → A → D` de `FR-011.4`, y con ella `D-01` entero.
 * 2. **El tier con el que se resolvió** sale de las capacidades declaradas y
 *    del token que llegó, no de un `if` por plataforma. Mientras `OQ-16` siga
 *    abierto, un adaptador con `renderedFetchEnabled: false` no puede resolver
 *    por tier C aunque lo declare soportado.
 * 3. **Lo que se devuelve está proyectado sobre
 *    `capabilities().profileSignals`.** Declarar en un lado y devolver en otro
 *    es lo que `OQ-19` advierte que va a doler: si el extractor trae una señal
 *    que no declaró, el orquestador pide OAuth cuando no hacía falta — o no lo
 *    pide cuando sí.
 * 4. **El orden de `readRecentContent`** es del más nuevo al más viejo. Es
 *    parte del contrato, no una conveniencia: `AI-016` pondera por engagement
 *    y `FR-011.3` habla de «los últimos N».
 *
 * **La URL canónica es sintética y sale del constructor.** La forma real de la
 * URL de perfil de cada plataforma es conocimiento del extractor de esa
 * plataforma; ponerla acá sería escribir en un adaptador de test una tabla que
 * después alguien copiaría como fuente de verdad. El default es
 * `memory://<fuente>/<handle>`, que no se puede confundir con nada.
 *
 * `INT-014` es explícito en que esto es **estrictamente de lectura**: no hay
 * método de escritura y no debe haberlo.
 */

import {
  DEFAULT_CONTENT_ITEMS,
  PortError,
  type AcquisitionTier,
  type BrandSourceType,
  type ProfileSignal,
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

const SOURCE = "SocialReader/memory";

export interface MemorySocialProfile {
  readonly handle: string;
  readonly signals: SocialProfileSignals;
  readonly content?: readonly SocialContentItem[];
  /** `private` ⇒ `ERR-B05`: existe, no se puede leer, y no bloquea el alta. */
  readonly visibility?: "public" | "private";
  readonly displayName?: string;
  readonly avatarUrl?: string;
}

export interface MemorySocialReaderOptions {
  /** Sin default: `P1-BRAND-001` pide una implementación por plataforma. */
  readonly capabilities: SocialReadCapabilities;
  readonly profiles?: readonly MemorySocialProfile[];
  /** Base de la URL canónica. Ver el encabezado: es sintética a propósito. */
  readonly canonicalUrlBase?: string;
}

/**
 * Buscar un perfil sembrado tiene los mismos tres finales que leerlo, y los
 * tres los comparten `readProfile` y `readRecentContent`. Sale nombrado para
 * que los dos métodos devuelvan el `SocialReadUnavailable` idéntico: que uno
 * lance donde el otro devuelve es justo lo que rompe la escalera de `FR-011.4`.
 */
type ProfileLookup =
  | { readonly status: "ok"; readonly profile: MemorySocialProfile }
  | {
      readonly status: "not_found" | "private";
      readonly attemptedTiers: readonly AcquisitionTier[];
    };

export class MemorySocialReader implements SocialReader {
  readonly #capabilities: SocialReadCapabilities;
  /** Indexado en minúsculas: los handles no distinguen mayúsculas al buscar. */
  readonly #profiles = new Map<string, MemorySocialProfile>();
  readonly #canonicalUrlBase: string;

  constructor(options: MemorySocialReaderOptions) {
    this.#capabilities = options.capabilities;
    this.#canonicalUrlBase =
      options.canonicalUrlBase ?? `memory://${options.capabilities.source}`;
    for (const profile of options.profiles ?? []) {
      this.#profiles.set(profile.handle.toLowerCase(), profile);
    }
  }

  get source(): BrandSourceType {
    return this.#capabilities.source;
  }

  capabilities(): SocialReadCapabilities {
    return this.#capabilities;
  }

  async resolve(
    request: ResolveSourceRequest,
  ): Promise<SocialReadOutcome<ResolvedSocialSource>> {
    const parsed = parseInput(request.input);
    const profile = this.#profiles.get(parsed.handle.toLowerCase());
    const tier = this.#resolvedTier(undefined);

    return {
      status: "ok",
      tier,
      data: {
        sourceType: this.source,
        handle: parsed.handle,
        canonicalUrl: `${this.#canonicalUrlBase}/${parsed.handle}`,
        // `available: false` ⇒ la forma era válida pero la cuenta no existe
        // (`ERR-B04`). §9.14 pide que resolve no cree nada y alimente la
        // detección en vivo: devolver un estado, no fallar, es el punto.
        available: profile !== undefined,
        ...(profile?.displayName === undefined
          ? {}
          : { displayName: profile.displayName }),
        ...(profile?.avatarUrl === undefined ? {} : { avatarUrl: profile.avatarUrl }),
        // `FR-011.1` / `ERR-B12`: si la entrada era un post hay que avisar que
        // se subió al perfil de su autor.
        ...(parsed.fromPost ? { resolvedFromPost: true } : {}),
      },
    };
  }

  async readProfile(
    request: ReadProfileRequest,
  ): Promise<SocialReadOutcome<SocialProfileSignals>> {
    const found = this.#lookup(request.handle);
    if (found.status !== "ok") return found;

    return {
      status: "ok",
      tier: this.#resolvedTier(request.accessToken),
      // Proyectado sobre lo declarado. El `accessToken` no aparece por
      // construcción: no hay ningún camino por el que entre a `data`.
      data: project(found.profile.signals, this.#capabilities.profileSignals),
    };
  }

  async readRecentContent(
    request: ReadContentRequest,
  ): Promise<SocialReadOutcome<readonly SocialContentItem[]>> {
    const limit = request.limit ?? DEFAULT_CONTENT_ITEMS;
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new PortError("bad_request", "limit must be a positive integer", {
        source: SOURCE,
      });
    }

    const found = this.#lookup(request.handle);
    if (found.status !== "ok") return found;

    const items = found.profile.content ?? [];
    if (items.length === 0) {
      // `ERR-B09`. Igual que los otros dos: degrada al tier D, no bloquea.
      return {
        status: "insufficient_content",
        attemptedTiers: this.#usableTiers(request.accessToken),
      };
    }

    const effective = Math.min(limit, this.#capabilities.maxContentItems);
    const ordered = [...items].sort(byNewestFirst).slice(0, effective);
    return { status: "ok", tier: this.#resolvedTier(request.accessToken), data: ordered };
  }

  #lookup(handle: string): ProfileLookup {
    const attemptedTiers = this.#usableTiers(undefined);
    const profile = this.#profiles.get(handle.trim().toLowerCase());
    if (profile === undefined) return { status: "not_found", attemptedTiers };
    if (profile.visibility === "private") return { status: "private", attemptedTiers };
    return { status: "ok", profile };
  }

  /**
   * Los tiers que este adaptador puede usar **ahora**. El tier C se cae si
   * está apagado (`OQ-16` / `P1-BRAND-013`) y el A si no hay token: declarar
   * que se soportan no es lo mismo que poder usarlos en esta llamada.
   */
  #usableTiers(accessToken: string | undefined): readonly AcquisitionTier[] {
    return this.#capabilities.tiers.filter((tier) => {
      if (tier === "C_rendered_fetch") return this.#capabilities.renderedFetchEnabled;
      if (tier === "A_oauth") return accessToken !== undefined;
      return true;
    });
  }

  #resolvedTier(accessToken: string | undefined): AcquisitionTier {
    const usable = this.#usableTiers(accessToken);
    // `FR-011.4` prefiere `A_oauth` cuando hay token: es la mejor señal. El
    // resto queda en el orden que declaró el adaptador.
    const best = usable.includes("A_oauth") ? "A_oauth" : usable[0];
    if (best === undefined) {
      throw new PortError("bad_request", "this reader has no usable tier", {
        source: SOURCE,
      });
    }
    return best;
  }
}

/** Lo más nuevo primero. Un ítem sin fecha va al final, no al medio. */
function byNewestFirst(a: SocialContentItem, b: SocialContentItem): number {
  const left = a.postedAt?.getTime();
  const right = b.postedAt?.getTime();
  if (left === undefined && right === undefined) return 0;
  if (left === undefined) return 1;
  if (right === undefined) return -1;
  return right - left;
}

function project(
  signals: SocialProfileSignals,
  declared: readonly ProfileSignal[],
): SocialProfileSignals {
  const allowed = new Set<string>(declared);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(signals)) {
    if (value !== undefined && allowed.has(key)) out[key] = value;
  }
  // El cast es sobre un objeto que se acaba de filtrar contra las claves de
  // `SocialProfileSignals`; `Object.entries` pierde el tipo y no hay forma de
  // recuperarlo sin repetir la lista de campos a mano.
  return out as SocialProfileSignals;
}

interface ParsedInput {
  readonly handle: string;
  readonly fromPost: boolean;
}

/**
 * `FR-011.1`: texto libre. URL con o sin esquema, o `@handle`.
 *
 * Que la entrada tenga más de un segmento de path significa que apuntaba a un
 * post y no al perfil; el contrato público lo tiene que avisar (`ERR-B12`),
 * así que se detecta acá y no se descarta en silencio.
 */
function parseInput(input: string): ParsedInput {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    // `ERR-B02`: una entrada que no resuelve a ninguna fuente.
    throw new PortError("bad_request", "empty input", { source: SOURCE });
  }

  if (!trimmed.includes("/") && !trimmed.includes(".")) {
    return { handle: stripAt(trimmed), fromPost: false };
  }

  let url: URL;
  try {
    url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
  } catch {
    throw new PortError("bad_request", "input does not resolve to a source", {
      source: SOURCE,
    });
  }

  const segments = url.pathname.split("/").filter((part) => part.length > 0);
  const first = segments[0];
  if (first === undefined) {
    throw new PortError("bad_request", "input has no handle", { source: SOURCE });
  }
  return { handle: stripAt(first), fromPost: segments.length > 1 };
}

function stripAt(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}
