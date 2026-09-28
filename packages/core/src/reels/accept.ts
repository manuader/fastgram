/**
 * Aceptar un reel de la cola de Blitz — sprint 9 (U), `PU-S9-014`.
 *
 * Es `acceptBlitzSuggestionUseCase` (`content/accept-blitz-suggestion.ts`)
 * para el formato `reel`, con **las mismas reglas de dinero y el mismo orden**:
 * cuota (saves y después swipes, `acceptBlitzSuggestion` de `quota/`), la
 * pieza en `BUILDING`, la sugerencia `popped` y el `content-build` encolado
 * **último y en la misma transacción** (ADR-005). Existe aparte porque aquel
 * caso de uso está atado a los cuatro formatos de `FR-050`
 * (`assertValidBlitzRequest`, `createBuildingContent` con cajas y slides) y
 * ampliar su tipo tocaba todo Blitz para un formato que no tiene cajas ni
 * `aspectRatio`.
 *
 * El repositorio es el **mismo puerto** (`BlitzAcceptanceRepository`), sin
 * `findSuggestion` ni idempotencia: la API y el piloto ya tienen la sugerencia
 * tomada con lock, y la idempotencia de `POST /blitz` vive en el borde.
 */
import type { Clock, EnqueuedJob, Queue, QueueTransaction } from "@fastgram/ports";
import { acceptBlitzSuggestion as gateQuota } from "../quota/content-saves.js";
import type { BlitzAcceptanceRepository } from "../content/accept-blitz-suggestion.js";
import type { Content } from "../content/content.js";
import { DomainError } from "../errors.js";
import type { IdGenerator } from "../ids.js";
import type { ContentBuildJob } from "../jobs/content-build.js";
import { JOB_QUEUES } from "../jobs/queues.js";

export type ReelAcceptanceRepository = Pick<
  BlitzAcceptanceRepository,
  "loadQuota" | "saveQuota" | "insertContent" | "markSuggestionPopped"
>;

export interface ReelSuggestionToAccept {
  readonly id: string;
  readonly companyId: string;
  readonly status: "queued" | "popped" | "discarded";
  readonly generatedText: string | null;
  readonly angleId: string | null;
}

export interface AcceptReelSuggestionOutput {
  readonly content: Content;
  readonly job: EnqueuedJob;
}

/** Tope de `generatedText` (`DATA-008`). */
const GENERATED_TEXT_MAX = 2_000;

export async function acceptReelSuggestionUseCase(
  deps: {
    readonly clock: Clock;
    readonly queue: Queue;
    readonly ids: IdGenerator;
    readonly repository: ReelAcceptanceRepository;
  },
  input: {
    readonly companyId: string;
    readonly suggestion: ReelSuggestionToAccept;
    readonly transaction: QueueTransaction;
  },
): Promise<AcceptReelSuggestionOutput> {
  const { suggestion, transaction } = input;
  if (suggestion.companyId !== input.companyId) {
    // La sugerencia ya viene tomada con el scope; esto cubre un llamador roto.
    throw new DomainError("not_found", "Suggestion not found.", {
      suggestionId: suggestion.id,
    });
  }
  if (suggestion.status !== "queued") {
    throw new DomainError(
      "invalid_state",
      suggestion.status === "popped"
        ? "That suggestion was already used."
        : "That suggestion was discarded.",
      { suggestionId: suggestion.id, status: suggestion.status },
    );
  }

  const quota = await deps.repository.loadQuota(input.companyId, transaction);
  const gated = gateQuota(quota.saves, quota.swipes);

  const text = suggestion.generatedText ?? "";
  const content: Content = {
    id: deps.ids.newId("cnt"),
    companyId: input.companyId,
    type: "reel",
    status: "BUILDING",
    files: [],
    generatedText: text === "" ? undefined : text.slice(0, GENERATED_TEXT_MAX),
    revision: 1,
    textBoxes: [],
    slideCount: 1,
    saveBucket: gated.bucket,
    angleId: suggestion.angleId ?? undefined,
    suggestionId: suggestion.id,
    editInProgress: false,
    linkedPostCount: 0,
    editable: true,
  };
  await deps.repository.insertContent(content, transaction);
  await deps.repository.saveQuota(
    input.companyId,
    { saves: gated.saves, swipes: gated.swipes },
    transaction,
  );
  await deps.repository.markSuggestionPopped(input.companyId, suggestion.id, transaction);

  const queueName = JOB_QUEUES.contentBuild;
  const payload: ContentBuildJob = {
    companyId: input.companyId,
    contentId: content.id,
    contentType: "reel",
    suggestionId: suggestion.id,
    revision: content.revision,
    reason: "blitz",
  };
  const job = await deps.queue.enqueue<ContentBuildJob>({
    queue: queueName,
    payload,
    options: {
      transaction,
      singletonKey: `${queueName}:${content.id}`,
      retryLimit: 2,
      retryBackoff: true,
    },
  });
  return { content, job };
}
