/**
 * Varios extractores de la misma plataforma, en escalera — PRD `FR-011.4`,
 * `PU-SCRAPE-002`, `PLAN-USO-PERSONAL.md` §6.1 («cada extractor tiene
 * fallback»).
 *
 * El handler del worker recibe **un** `SocialReader` por plataforma (§9.14:
 * «un extractor por plataforma detrás de una interfaz común»). Instagram tiene
 * dos vías —Business Discovery (B, oficial) e instaloader anónimo (C)— y esto
 * las presenta como una, probando en el orden en que se construyó. Quien monta
 * decide el orden; el normativo es **B → C**.
 *
 * ## La regla, en una línea: **decide el último que se intentó**
 *
 * Se prueba cada extractor hasta que uno lee (`ok`). Si ninguno lee, lo que
 * vale es el resultado —o el error— del **último**, porque es el que tenía la
 * cobertura más amplia:
 *
 *  - B «no califica» (`not_found`) + C `ok` → `ok` de C.
 *  - B «no califica» + C 429 → el 429: el job reintenta y, agotado, degrada a D
 *    con `rate_limited` (`ERR-B08`). Es el caso que el anónimo va a dar seguido.
 *  - B 429 + C `not_found` → `not_found`: C sí sabe que no existe.
 *  - B sin credencial (`extractor_unavailable`) + C `not_found` → `not_found`.
 *  - B `not_found` + C sin instaloader (`extractor_unavailable`) →
 *    `extractor_unavailable`: la instalación no puede leer Instagram, que es
 *    más verdad que «no existe».
 *
 * `readRecentContent` usa el extractor que resolvió el perfil de ese handle,
 * para que perfil y posts salgan de la misma lectura.
 */
import type {
  AcquisitionTier,
  BrandSourceType,
  ContentSignal,
  ProfileSignal,
  ReadContentRequest,
  ReadProfileRequest,
  ResolvedSocialSource,
  ResolveSourceRequest,
  SocialContentItem,
  SocialProfileSignals,
  SocialReadCapabilities,
  SocialReader,
  SocialReadOutcome,
} from "@fastgram/ports";

export class LadderSocialReader implements SocialReader {
  readonly source: BrandSourceType;
  readonly #readers: readonly SocialReader[];
  /** handle → índice del extractor que leyó el perfil. */
  readonly #resolvedBy = new Map<string, number>();

  constructor(readers: readonly SocialReader[]) {
    const first = readers[0];
    if (first === undefined) throw new Error("LadderSocialReader: sin extractores");
    if (readers.some((r) => r.source !== first.source)) {
      throw new Error(
        "LadderSocialReader: todos los extractores tienen que ser de la misma fuente",
      );
    }
    this.source = first.source;
    this.#readers = readers;
  }

  capabilities(): SocialReadCapabilities {
    const caps = this.#readers.map((r) => r.capabilities());
    const tiers: AcquisitionTier[] = [];
    const profile = new Set<ProfileSignal>();
    const content = new Set<ContentSignal>();
    for (const c of caps) {
      for (const t of c.tiers) if (!tiers.includes(t)) tiers.push(t);
      for (const s of c.profileSignals) profile.add(s);
      for (const s of c.contentSignals) content.add(s);
    }
    return {
      source: this.source,
      tiers,
      profileSignals: [...profile],
      contentSignals: [...content],
      maxContentItems: Math.max(...caps.map((c) => c.maxContentItems)),
      requiresConnection: caps.every((c) => c.requiresConnection),
      renderedFetchEnabled: caps.some((c) => c.renderedFetchEnabled),
    };
  }

  async #climb<T>(
    from: number,
    read: (reader: SocialReader) => Promise<SocialReadOutcome<T>>,
  ): Promise<{ readonly outcome: SocialReadOutcome<T>; readonly index: number }> {
    let last:
      | { kind: "outcome"; outcome: SocialReadOutcome<T> }
      | { kind: "error"; error: unknown }
      | null = null;
    const attempted: AcquisitionTier[] = [];
    for (let i = from; i < this.#readers.length; i++) {
      const reader = this.#readers[i] as SocialReader;
      try {
        const outcome = await read(reader);
        if (outcome.status === "ok") return { outcome, index: i };
        attempted.push(...outcome.attemptedTiers);
        last = { kind: "outcome", outcome };
      } catch (error: unknown) {
        attempted.push(...reader.capabilities().tiers);
        last = { kind: "error", error };
      }
    }
    if (last === null) throw new Error("LadderSocialReader: escalera vacía");
    if (last.kind === "error") throw last.error;
    const outcome = last.outcome;
    if (outcome.status === "ok") return { outcome, index: this.#readers.length - 1 };
    return {
      outcome: { status: outcome.status, attemptedTiers: [...new Set(attempted)] },
      index: this.#readers.length - 1,
    };
  }

  async resolve(
    request: ResolveSourceRequest,
  ): Promise<SocialReadOutcome<ResolvedSocialSource>> {
    return (await this.#climb(0, (r) => r.resolve(request))).outcome;
  }

  async readProfile(
    request: ReadProfileRequest,
  ): Promise<SocialReadOutcome<SocialProfileSignals>> {
    const { outcome, index } = await this.#climb(0, (r) => r.readProfile(request));
    if (outcome.status === "ok") this.#resolvedBy.set(request.handle, index);
    return outcome;
  }

  async readRecentContent(
    request: ReadContentRequest,
  ): Promise<SocialReadOutcome<readonly SocialContentItem[]>> {
    const known = this.#resolvedBy.get(request.handle);
    if (known !== undefined) {
      this.#resolvedBy.delete(request.handle);
      const reader = this.#readers[known] as SocialReader;
      return reader.readRecentContent(request);
    }
    return (await this.#climb(0, (r) => r.readRecentContent(request))).outcome;
  }
}
