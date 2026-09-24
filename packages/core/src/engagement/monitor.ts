/**
 * Seguimiento del hilo después de responder — `F-198`, `F-199`,
 * `P4-ENGAGE-011`. Pura: recibe el árbol de comentarios ya leído
 * (`GET /comments/{article}`, scope `read`) y dice en qué estado está.
 *
 * Los campos que usa son los de la wiki JSON de Reddit
 * (https://github.com/reddit-archive/reddit/wiki/JSON): `author`, `name`
 * (fullname `t1_…`), `parent_id` (*"ID of the thing this comment is a reply
 * to"*), `locked`, `num_comments`.
 *
 * ## Estados (`leads.thread_state`)
 *
 * El PRD no los enumera (DATA-024 lo deja en texto). Los nuestros:
 *
 * - `new` — nadie respondió todavía desde FastGram.
 * - `tracking` — respondimos y el comentario se ve en el hilo.
 * - `comment_missing` — respondimos y **no** aparece: lo borró un moderador
 *   o lo filtró el spam de Reddit. Es la señal más valiosa del módulo: si se
 *   repite, la cuenta está siendo filtrada (el nivel `danger` del PRD dice
 *   *"You're likely being spam-filtered on some subreddits"*).
 * - `locked` — el hilo se cerró a comentarios nuevos.
 */

export const THREAD_STATES = ["new", "tracking", "comment_missing", "locked"] as const;
export type ThreadState = (typeof THREAD_STATES)[number];

export interface ThreadComment {
  /** Fullname `t1_…`. */
  readonly name: string;
  readonly author: string | null;
  /** Fullname del padre: `t3_…` (el post) o `t1_…`. */
  readonly parentId: string;
  readonly createdUtc: number;
}

export interface ThreadSnapshot {
  readonly postId: string;
  readonly locked: boolean;
  readonly numComments: number;
  readonly score: number;
  /** Aplanado (los `replies` anidados, recorridos). Puede estar incompleto (`more`). */
  readonly comments: readonly ThreadComment[];
}

export interface ThreadSummary {
  readonly threadState: ThreadState;
  /** Comentarios nuestros visibles. */
  readonly ourComments: number;
  /** Respuestas directas a alguno de los nuestros. */
  readonly repliesToUs: number;
  /** El hilo tiene más comentarios que la última vez que se miró. */
  readonly newActivity: boolean;
  readonly numComments: number;
  readonly score: number;
}

export function summarizeThread(input: {
  readonly snapshot: ThreadSnapshot;
  /** Usuario de Reddit de la cuenta conectada, o `null` si no hay (modo manual). */
  readonly ownUsername: string | null;
  /** Fullnames de los comentarios que se enviaron desde FastGram (si se conocen). */
  readonly sentCommentNames: readonly string[];
  /** Si se envió algo (por API o marcado a mano). */
  readonly replied: boolean;
  /** `num_comments` de la última lectura, o `null` si es la primera. */
  readonly previousNumComments: number | null;
}): ThreadSummary {
  const { snapshot } = input;
  const own = input.ownUsername?.toLowerCase() ?? null;
  const ours = snapshot.comments.filter(
    (c) =>
      input.sentCommentNames.includes(c.name) ||
      (own !== null && c.author !== null && c.author.toLowerCase() === own),
  );
  const ourNames = new Set(ours.map((c) => c.name));
  const repliesToUs = snapshot.comments.filter((c) => ourNames.has(c.parentId)).length;

  let threadState: ThreadState;
  if (input.replied && ours.length > 0) threadState = "tracking";
  else if (snapshot.locked) threadState = "locked";
  else if (input.replied && (own !== null || input.sentCommentNames.length > 0)) {
    threadState = "comment_missing";
  } else threadState = input.replied ? "tracking" : "new";

  return {
    threadState,
    ourComments: ours.length,
    repliesToUs,
    newActivity:
      input.previousNumComments !== null &&
      snapshot.numComments > input.previousNumComments,
    numComments: snapshot.numComments,
    score: snapshot.score,
  };
}

/** Cuánto tiempo se sigue un hilo después de responder. Decisión nuestra. */
export const THREAD_MONITORING = {
  followDays: 7,
  /** Hilos que se revisan por corrida, por marca. */
  maxThreadsPerRun: 20,
} as const;
