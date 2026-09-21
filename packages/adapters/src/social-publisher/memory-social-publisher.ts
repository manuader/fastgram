/**
 * `SocialPublisher` en memoria — PRD `INT-001`…`INT-006`, `FR-060`,
 * `NFR-012`, `NFR-015`.
 *
 * **Acá no se publica nada en ninguna plataforma**, y es lo que hace que este
 * adaptador se pueda usar en tests sin miedo: `FR-060` es explícito en que un
 * post entregado al carril lento de TikTok no se puede reprogramar sin
 * duplicar, así que un test que publique de verdad no se puede deshacer.
 *
 * **Las capacidades no tienen default y se piden por constructor.** Es la
 * decisión más importante del archivo. `INT-006` dice que hay más de una ruta
 * por plataforma con capacidades distintas; si este adaptador trajera una tabla
 * de "lo que soporta TikTok" —límites de caption, modos, tipos de cuenta—,
 * sería una fuente de verdad sobre un proveedor escrita sin evidencia, y
 * alguien la copiaría al adaptador real. Quien monta el adaptador declara las
 * capacidades que quiere ejercitar; acá no se infiere ninguna.
 *
 * **Lo que sí es lógica real**, y por eso vale correrla:
 *
 * 1. **Coherencia entre lo declarado y lo aceptado.** Todo `publish` se valida
 *    contra las propias capacidades antes de tocar nada: media no declarada,
 *    caption por encima del límite, `postingMode` que la ruta no tiene,
 *    `direct` sin `privacyLevel` (`FR-060`), `aiGenerated` sin
 *    `supportsAiLabel` (`INT-002`). Es la mitad del puerto que no depende del
 *    proveedor y la que `P3-OAUTH-011` necesita que sea igual en todos.
 * 2. **Idempotencia por `idempotencyKey`** (`NFR-015`). El duplicado del
 *    carril lento es el fallo caro de este puerto: se descubre cuando ya está
 *    publicado dos veces.
 * 3. **El tope de lote de `NFR-012`** y la deduplicación previa que el mismo
 *    requisito pide.
 */

import {
  MAX_METRICS_BATCH,
  PortError,
  type AccountPublishOptions,
  type CancelOutcome,
  type Clock,
  type PostMetrics,
  type PublishAccountRef,
  type PublishRef,
  type PublishRequest,
  type PublishStatus,
  type SocialPublishCapabilities,
  type SocialPublisher,
} from "@fastgram/ports";
import { systemClock } from "../clock/index.js";

const SOURCE = "SocialPublisher/memory";

/** Métricas que se pueden sembrar por post, sin el `syncedAt` que pone el reloj. */
export type MemoryPostMetrics = Omit<PostMetrics, "externalPostId" | "syncedAt">;

export interface MemorySocialPublisherOptions {
  /**
   * Sin default a propósito: ver el encabezado. Una tabla de capacidades por
   * plataforma acá sería una afirmación sobre un proveedor sin evidencia.
   */
  readonly capabilities: SocialPublishCapabilities;
  readonly clock?: Clock;
  /** `accountId` → lo que la API por cuenta responde. Default: lo declarado. */
  readonly accountOptions?: Readonly<Record<string, AccountPublishOptions>>;
  /** `externalPostId` → métricas. Un id sin entrada no aparece en la respuesta. */
  readonly metrics?: Readonly<Record<string, MemoryPostMetrics>>;
  /**
   * Resultados a devolver, en orden, antes de caer al default `published`.
   * Es la forma de ejercitar el camino de fallo sin inventar un error de
   * plataforma dentro del adaptador.
   */
  readonly outcomes?: readonly PublishStatus[];
  readonly permalinkBaseUrl?: string;
}

export class MemorySocialPublisher implements SocialPublisher {
  readonly #capabilities: SocialPublishCapabilities;
  readonly #clock: Clock;
  readonly #accountOptions: Map<string, AccountPublishOptions>;
  readonly #metrics: Map<string, MemoryPostMetrics>;
  readonly #scripted: PublishStatus[];
  readonly #baseUrl: string;
  /** `idempotencyKey` → resultado ya devuelto. La defensa de `NFR-015`. */
  readonly #byKey = new Map<string, PublishStatus>();
  readonly #byPostId = new Map<string, PublishStatus>();
  #counter = 0;

  constructor(options: MemorySocialPublisherOptions) {
    this.#capabilities = options.capabilities;
    this.#clock = options.clock ?? systemClock;
    this.#accountOptions = new Map(Object.entries(options.accountOptions ?? {}));
    this.#metrics = new Map(Object.entries(options.metrics ?? {}));
    this.#scripted = [...(options.outcomes ?? [])];
    this.#baseUrl = options.permalinkBaseUrl ?? "https://social.invalid/p";
  }

  capabilities(): SocialPublishCapabilities {
    return this.#capabilities;
  }

  async getAccountOptions(account: PublishAccountRef): Promise<AccountPublishOptions> {
    const seeded = this.#accountOptions.get(account.accountId);
    if (seeded !== undefined) return seeded;
    // Default: lo que la ruta declara. `INT-001` dice que los permitidos por
    // cuenta son un subconjunto de los de la ruta, nunca un superconjunto.
    return {
      allowedPrivacyLevels: this.#capabilities.privacyLevels,
      directPostingAvailable: this.#capabilities.postingModes.includes("direct"),
    };
  }

  async publish(request: PublishRequest): Promise<PublishStatus> {
    if (request.idempotencyKey.length === 0) {
      throw new PortError("bad_request", "idempotencyKey is required", {
        source: SOURCE,
      });
    }
    // Antes de validar: un reintento del mismo pedido tiene que devolver lo
    // mismo aunque el pedido original hubiera sido rechazado por otra razón.
    const already = this.#byKey.get(request.idempotencyKey);
    if (already !== undefined) return already;

    this.#assertMatchesCapabilities(request);

    const scripted = this.#scripted.shift();
    const status: PublishStatus = scripted ?? this.#publishedStatus(request);

    this.#byKey.set(request.idempotencyKey, status);
    if (status.externalPostId !== undefined) {
      this.#byPostId.set(status.externalPostId, status);
    }
    return status;
  }

  async getStatus(ref: PublishRef): Promise<PublishStatus | null> {
    // `null` y no `not_found`: el watcher pregunta por posts que la plataforma
    // puede haber perdido, y eso no es un fallo de transporte.
    return this.#byPostId.get(ref.externalPostId) ?? null;
  }

  async cancel(ref: PublishRef): Promise<CancelOutcome> {
    const status = this.#byPostId.get(ref.externalPostId);
    if (status === undefined) {
      throw new PortError("not_found", "unknown post reference", { source: SOURCE });
    }
    if (status.kind === "published" || status.kind === "failed") {
      // Ya terminó. No es error pedir cancelarlo; simplemente no se pudo.
      return { cancelled: false, pending: false };
    }
    const cancelled: PublishStatus = { ...status, kind: "cancelled" };
    this.#byPostId.set(ref.externalPostId, cancelled);
    return { cancelled: true, pending: false };
  }

  async fetchMetrics(refs: readonly PublishRef[]): Promise<readonly PostMetrics[]> {
    if (refs.length > MAX_METRICS_BATCH) {
      throw new PortError(
        "bad_request",
        `at most ${String(MAX_METRICS_BATCH)} references per call`,
        { source: SOURCE },
      );
    }

    // `NFR-012` pide deduplicación previa: pedir el mismo id dos veces no
    // puede gastar dos veces del presupuesto ni devolverlo repetido.
    const unique = [...new Set(refs.map((ref) => ref.externalPostId))];
    const syncedAt = this.#clock.now();
    const out: PostMetrics[] = [];
    for (const externalPostId of unique) {
      const seeded = this.#metrics.get(externalPostId);
      // Un id que la plataforma no reconoce simplemente no aparece: pedir
      // métricas no es preguntar por existencia.
      if (seeded === undefined) continue;
      out.push({ ...seeded, externalPostId, syncedAt });
    }
    return out;
  }

  #publishedStatus(request: PublishRequest): PublishStatus {
    this.#counter += 1;
    const externalPostId = `mem_${String(this.#counter)}`;
    const inbox = request.postingMode === "inbox";
    return {
      // `IN_USER_INBOX` **no es un error**: falta que el usuario pulse Post.
      kind: inbox ? "in_user_inbox" : "published",
      externalPostId,
      ...(inbox ? {} : { permalink: `${this.#baseUrl}/${externalPostId}` }),
      publishedCaption: request.caption,
    };
  }

  #assertMatchesCapabilities(request: PublishRequest): void {
    const caps = this.#capabilities;
    const bad = (message: string): never => {
      throw new PortError("bad_request", message, { source: SOURCE });
    };

    if (!caps.accountTypes.includes(request.account.accountType)) {
      bad("this route does not support that account type");
    }
    if (!caps.mediaKinds.includes(request.media.kind)) {
      bad("this route does not support that media kind");
    }
    if (request.media.urls.length === 0 && request.media.kind !== "text") {
      bad("media without urls");
    }
    if (request.caption.length > caps.captionLimits.caption) {
      bad("caption is longer than this route allows");
    }
    const descriptionLimit = caps.captionLimits.description;
    if (request.description !== undefined) {
      if (descriptionLimit === undefined) {
        bad("this route has no description field");
      } else if (request.description.length > descriptionLimit) {
        bad("description is longer than this route allows");
      }
    }
    if (
      request.postingMode !== undefined &&
      !caps.postingModes.includes(request.postingMode)
    ) {
      bad("this route has no posting modes");
    }
    if (request.postingMode === "direct" && request.privacyLevel === undefined) {
      // `FR-060`: el modo direct exige nivel de privacidad. Sin él, el post
      // saldría con la visibilidad que la plataforma decida.
      bad("direct posting requires a privacy level");
    }
    if (
      request.privacyLevel !== undefined &&
      !caps.privacyLevels.includes(request.privacyLevel)
    ) {
      bad("this route does not declare that privacy level");
    }
    if (request.aiGenerated === true && !caps.supportsAiLabel) {
      // `INT-002`: la etiqueta de contenido IA existe sólo por una ruta.
      // Aceptarla en otra publicaría sin el disclosure que `NFR-024` pide.
      bad("this route cannot label AI-generated content");
    }
    if (request.paidPartnership === true && !caps.supportsPartnershipDisclosure) {
      bad("this route cannot disclose a paid partnership");
    }
    if (request.autoAddMusic === true && !caps.supportsAutoAddMusic) {
      bad("this route does not support auto-add music");
    }
  }
}
