/**
 * Mover un post o un slot en el calendario — `PU-CAL-002`, `FR-060`, `FR-110`.
 *
 * *"Sólo se mueven los no publicados."* La regla fina sale de la máquina de
 * estados de `FR-060` y de lo que ya decide `assertCanReschedule`:
 *
 * - Se mueven `BUILDING`, `CREATED`, `SCHEDULED` y `AWAITING_RECONNECT`: los
 *   que todavía no salieron de nuestro lado (la misma lista que se puede
 *   cancelar en `apps/api/src/routes/v1/posts.ts`).
 * - `UPLOADING_TO_TIKTOK` e `IN_USER_INBOX` ya están en manos del proveedor;
 *   `POSTED`, `FAILED`, `DELETED` y `CANCELLED` no tienen futuro que mover.
 * - `tiktokProcessingDelayed` y `cancellationPending` bloquean, como en
 *   `assertCanReschedule` (reprogramar ahí crea un duplicado).
 * - **Las cuentas warmed no se mueven desde el calendario.** Mover un post es
 *   cancelarlo y recrearlo (ver `apps/api`), y cancelar uno warmed no es
 *   inmediato: queda `cancellationPending` hasta que la persona que opera la
 *   cuenta confirma. Un "mover" que deja dos posts vivos es peor que un 409.
 */
import { DomainError } from "../errors.js";

/**
 * Los diez estados de `FR-060`, repetidos como literal y no importados de
 * `schedule-post.ts`: ese archivo re-exporta éste (ver su pie), y un import de
 * vuelta sería un ciclo que `no-circular` de dependency-cruiser rechaza —cuenta
 * también los `import type`—. El test de `calendar-move.test.ts` fija que las
 * dos listas coincidan.
 */
type PostStatus =
  | "BUILDING"
  | "CREATED"
  | "SCHEDULED"
  | "UPLOADING_TO_TIKTOK"
  | "IN_USER_INBOX"
  | "POSTED"
  | "FAILED"
  | "DELETED"
  | "AWAITING_RECONNECT"
  | "CANCELLED";

export const MOVABLE_POST_STATUSES: readonly PostStatus[] = [
  "BUILDING",
  "CREATED",
  "SCHEDULED",
  "AWAITING_RECONNECT",
];

export interface MovablePost {
  readonly id: string;
  readonly status: PostStatus;
  readonly accountType: "oauth" | "warmed";
  readonly tiktokProcessingDelayed: boolean;
  readonly cancellationPending: boolean;
  readonly scheduledFor: Date;
}

/** `true` si el calendario puede ofrecer arrastrarlo. No lanza. */
export function isMovablePost(post: MovablePost): boolean {
  try {
    assertCanMovePost(post, post.scheduledFor, new Date(0));
    return true;
  } catch {
    return false;
  }
}

/**
 * Lanza `DomainError` si no se puede mover a `to`. `now` decide que la hora
 * nueva sea futura: una hora pasada arrancaría el job en el acto, que es un
 * "publicar ahora" por la puerta de atrás (mismo motivo que en `schedule`).
 */
export function assertCanMovePost(post: MovablePost, to: Date, now: Date): void {
  // Las dos primeras son las de `assertCanReschedule` (`schedule-post.ts`),
  // con el mismo mensaje: ver la nota del tipo `PostStatus` sobre el ciclo.
  if (post.tiktokProcessingDelayed) {
    throw new DomainError(
      "conflict",
      "TikTok is still processing this post. Rescheduling now would post it twice.",
      { postId: post.id },
    );
  }
  if (post.cancellationPending) {
    throw new DomainError(
      "conflict",
      "This post is being cancelled. Wait for it to settle.",
      {
        postId: post.id,
      },
    );
  }
  if (!MOVABLE_POST_STATUSES.includes(post.status)) {
    throw new DomainError(
      "invalid_state",
      "Only posts that haven't gone out can be moved.",
      {
        postId: post.id,
        status: post.status,
      },
    );
  }
  if (post.accountType === "warmed") {
    throw new DomainError(
      "conflict",
      "Warmed-account posts can't be moved from the calendar. Cancel it and schedule it again.",
      { postId: post.id },
    );
  }
  assertFuture(to, now);
}

/** Un slot planificado se mueve mientras siga planificado y a una hora futura. */
export function assertCanMoveSlot(
  slot: { readonly id: string; readonly status: "planned" | "converted" },
  to: Date,
  now: Date,
): void {
  if (slot.status !== "planned") {
    throw new DomainError(
      "invalid_state",
      "This slot already became a post. Move the post instead.",
      { slotId: slot.id },
    );
  }
  assertFuture(to, now);
}

function assertFuture(to: Date, now: Date): void {
  if (to.getTime() <= now.getTime()) {
    throw new DomainError("out_of_range", "Pick a time in the future.", {
      scheduledAtUtc: to.getTime(),
    });
  }
}
