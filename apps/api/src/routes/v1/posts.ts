/**
 * Posts — `GET /posts`, `GET /posts/:id`, `POST /content/:id/schedule`,
 * `POST /posts/cancel`, `POST /posts/delete`, `POST /analytics/posts`.
 *
 * Fuente: PRD §9.2, §9.3, §12, FR-060, NFR-011, NFR-012, ERR-F01, ERR-F02.
 *
 * ## Las dos semánticas de lote conviven acá, y son opuestas a propósito
 *
 * `cancel` y `delete` son **todo o nada** (NFR-011, PRD:2970 · ERR-F01, PRD:3209): si un
 * solo id falla no se aplica nada y el error lleva `details.failures` con el motivo por
 * id. `analytics` es **éxito parcial** (ERR-F02, PRD:3201): un id desconocido vuelve como
 * `{"_id":"…","notFound":true}` dentro de un `200`. La diferencia no es un descuido del
 * PRD: leer métricas no muta nada, así que abortar por un id viejo sería hostil; borrar
 * 99 de 100 posts deja al cliente sin saber qué quedó vivo.
 *
 * ## Por qué `details.failures` no filtra existencia cruzada
 *
 * PRD §9.2 pide 404 y nunca 403 para no revelar si un id existe en otro workspace, y un
 * lote que reportara motivos distintos según el dueño sería el mismo canal lateral por
 * otra puerta. No lo es porque **todas** las búsquedas pasan por los repositorios
 * scopeados: un post ajeno y uno inexistente devuelven los dos `null`, y los dos salen
 * como `not_found`. Los motivos que sí distinguen algo —`not_cancellable_status:<estado>`,
 * `cancellation_pending`— sólo pueden calcularse sobre una fila que el scope ya dejó
 * pasar, es decir sobre datos del propio workspace.
 *
 * ## Lo que el PRD no contesta y se decidió acá (ver el reporte)
 *
 * 1. **Qué estados se pueden cancelar.** El PRD nombra el motivo
 *    `not_cancellable_status:<status>` (ERR-F01) pero **no enumera** los estados
 *    cancelables. La lista de {@link CANCELLABLE_POST_STATUSES} es una decisión de esta
 *    tajada, con su razón al lado.
 * 2. **Re-cancelar un post ya `CANCELLED`** es un no-op exitoso, no un fallo. Si fuera un
 *    fallo, el reintento de un lote que se cortó por timeout fallaría entero y el
 *    endpoint dejaría de ser reintentable.
 * 3. **`past_cutoff` / `past_submit_cutoff` no se implementan.** FR-060 dice *"Posts
 *    scheduled for today are handed off quickly and can't be cancelled once they're being
 *    posted"* y no da ningún número. Inventar una ventana sería inventar comportamiento
 *    backend; lo observable de esa regla —que un post ya entregado al proveedor no se
 *    cancela— queda cubierto por el estado (`UPLOADING_TO_TIKTOK`, `IN_USER_INBOX`).
 * 4. **Cancelar una cuenta warmed deja `cancellationPending`, no `CANCELLED`.** Ver
 *    {@link cancelPatchOf}. El campo es del PRD; que se aplique a *todo* cancel warmed y
 *    no sólo al "en curso" es la decisión, y sale del mismo hueco que el punto 3.
 *
 * ## `POST /posts/delete` borra la fila, y eso contradice al §12
 *
 * `posts` no tiene columna de soft-delete, así que el repositorio sólo ofrece
 * `hardDelete`. Pero `DELETED` es un estado normativo del post (FR-060, PRD:1387) **y**
 * un valor documentado del filtro `GET /posts?status=` (§12, PRD:2723): con borrado real,
 * ese filtro no puede devolver nunca una fila. La contradicción está reportada; no se
 * resuelve desde una ruta porque la alternativa —`UPDATE status='DELETED'`— es un cambio
 * de schema y de semántica que le toca a `packages/db`.
 */
import { z } from "zod";
import {
  PAGINATION_LIMIT_MAX,
  WARMED_MAX_SCHEDULE_DAYS_AHEAD,
  cancelPostsRequestSchema,
  deletePostsRequestSchema,
  listPostsQuerySchema,
  postAnalyticsRequestSchema,
  scheduleContentRequestSchema,
  type BatchFailureReason,
  type ScheduleTarget,
} from "@fastgram/contracts";
import {
  connectionRepository,
  contentRepository,
  postRepository,
  warmedAccountRepository,
} from "@fastgram/db";
import type { JobSpec } from "@fastgram/ports";
import type { FastifyReply } from "fastify";

import { JOB_QUEUES } from "@fastgram/core";

import { rateLimit } from "../../plugins/rate-limit.js";
import { toPost } from "../../support/serializers.js";
import { crossTenant, data, notFound, page } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const idParams = z.object({ id: z.string().min(1) });

/**
 * Cola del *publishing job* (§9.5 punto 8).
 *
 * **Esto decía `"publish-post"` y estaba roto.** El literal se escribió acá cuando no
 * había registro compartido de colas, con la nota de que *"el worker que lo consuma tiene
 * que usar el mismo string y hoy nada lo verifica"*. El registro apareció después
 * (`JOB_QUEUES` en `packages/core`) y nombró a esta cola **`"publishing"`**, así que los
 * dos nombres convivieron sin que nada fallara en los tests.
 *
 * Y no era cosmético: `main.ts` registra `[...ALL_JOB_QUEUES]`, que **no contiene**
 * `"publish-post"`, y pg-boss se niega a encolar en una cola no registrada dentro de una
 * transacción. Medido contra pg-boss de verdad:
 *
 * ```
 * FALLO  en "publish-post" -> Queue "publish-post" must be registered before
 *                             enqueuing inside a transaction
 * ENCOLO en "publishing"
 * ```
 *
 * O sea que **programar un post devolvía 500, siempre**. Los tests de integración no lo
 * podían ver porque el arnés usaba una cola que acepta cualquier nombre; ahora valida
 * contra `ALL_JOB_QUEUES`, que es lo que convierte a cada test de ruta en una guarda.
 * Cuarta aparición de la misma clase de bug — ver la trampa 19.
 */
const PUBLISH_POST_QUEUE = JOB_QUEUES.publishing;

/**
 * Los estados desde los que cancelar tiene sentido. **Decisión de esta tajada**: el PRD
 * enumera los estados (FR-060, PRD:1387) y nombra el motivo `not_cancellable_status`
 * (ERR-F01) pero nunca dice cuáles son cuáles.
 *
 * Los cuatro que entran son los que todavía no salieron de nuestro lado:
 * `BUILDING` y `CREATED` ni siquiera tienen media listo; `SCHEDULED` espera su hora;
 * `AWAITING_RECONNECT` está parado esperando al usuario (FR-060: se reanuda a `SCHEDULED`
 * o vence a `FAILED`), así que cancelarlo es exactamente lo que alguien querría hacer en
 * vez de reconectar.
 *
 * Los que quedan afuera, y por qué:
 * - `UPLOADING_TO_TIKTOK` e `IN_USER_INBOX` — el post ya está en manos del proveedor.
 *   `IN_USER_INBOX` es un borrador dentro de la app del creador (FR-060) y no hay forma de
 *   retirarlo desde acá; decir "cancelado" sería mentir sobre algo que el usuario puede
 *   publicar de un toque. Es además donde vive `NFR-015`: no duplicar ni tocar el carril
 *   lento de TikTok.
 * - `POSTED` — ya se publicó. Cancelar no des-publica.
 * - `FAILED` y `DELETED` — no queda nada futuro que cancelar.
 * - `CANCELLED` — no falla, pero tampoco se vuelve a escribir: ver {@link cancelFailureOf}.
 */
export const CANCELLABLE_POST_STATUSES: ReadonlySet<string> = new Set([
  "BUILDING",
  "CREATED",
  "SCHEDULED",
  "AWAITING_RECONNECT",
]);

/**
 * Forma de una fila de post reducida a lo que decide una cancelación. Es estructural y no
 * el tipo de la tabla para que la regla se pueda testear sin levantar la base.
 */
export interface CancellablePost {
  readonly status: string;
  readonly cancellationPending: boolean;
  readonly accountType: "oauth" | "warmed";
}

/** El patch que aplica una cancelación. `null` = la fila ya está donde tiene que estar. */
export type CancelPatch =
  { readonly status: "CANCELLED" } | { readonly cancellationPending: true } | null;

/**
 * Cancelar no escribe lo mismo en los dos tipos de cuenta — FR-060 (PRD:1393).
 *
 * Una conexión OAuth publica nuestro propio job: pararlo es una decisión que tomamos
 * nosotros y el post pasa a `CANCELLED`. Una cuenta warmed la opera una persona con un
 * teléfono real; el PRD tiene un campo entero para esa incertidumbre
 * (`cancellationPending: true`, *"se resuelve sola a CANCELLED o a POSTED si salió
 * antes"*) y la UI lo muestra como `Cancellation pending`.
 *
 * **Todo cancel warmed queda pendiente, no sólo el "en curso".** Distinguir los dos
 * necesitaría saber cuándo se hizo el hand-off, y FR-060 sólo dice *"handed off quickly"*
 * sin un número. Con esa ambigüedad, marcar pendiente de más nunca miente; marcar
 * `CANCELLED` de menos le dice al usuario que algo no va a salir cuando puede salir.
 */
export function cancelPatchOf(row: CancellablePost): CancelPatch {
  if (row.status === "CANCELLED") return null;
  if (row.accountType === "warmed") return { cancellationPending: true };
  return { status: "CANCELLED" };
}

/** Qué le pasa a un id dentro de un lote: `null` = se aplica, string = motivo del fallo. */
export type BatchOutcome = BatchFailureReason | null;

/**
 * Los ids del contrato son **opacos** (`postIdSchema` valida "string no vacío"), pero la
 * columna es `uuid`. Mandar `"no-soy-un-uuid"` a Postgres no devuelve cero filas: levanta
 * *invalid input syntax for type uuid* y sale como `500`, que es un error nuestro por un
 * dato del cliente.
 *
 * ERR-F01 y ERR-F02 existen justamente para esto —`invalid_id` en el lote de cancel/delete
 * y `details.invalidIds` en el de analytics—, así que la forma se comprueba acá antes de
 * tocar la base. Es el único punto del archivo que sabe cómo se almacena un id.
 */
const STORAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isStorableId(id: string): boolean {
  return STORAGE_ID_RE.test(id);
}

/**
 * Decide un id de `POST /posts/cancel`.
 *
 * `undefined` significa que el repositorio scopeado no lo encontró: id inexistente o de
 * otro workspace, indistinguibles por diseño (§9.2).
 */
export function cancelFailureOf(row: CancellablePost | undefined): BatchOutcome {
  if (row === undefined) return "not_found";
  // FR-060: una cancelación warmed en curso "se resuelve sola a CANCELLED o a POSTED".
  // Pedirla otra vez no acelera nada y el PRD dice explícitamente **no reintentar**.
  if (row.cancellationPending) return "cancellation_pending";
  if (row.status === "CANCELLED") return null;
  if (CANCELLABLE_POST_STATUSES.has(row.status)) return null;
  return `not_cancellable_status:${row.status}`;
}

/**
 * Decide un id de `POST /posts/delete`.
 *
 * Sin puerta de estado: el PRD no restringe el borrado por estado en ningún lado, y
 * ERR-P06 empuja en la dirección contraria —*"cancelar no basta, hay que borrarlos"*— para
 * poder liberar un contenido con posts vinculados. Inventar una restricción bloquearía esa
 * salida, que es la única que el PRD documenta.
 */
export function deleteFailureOf(row: unknown): BatchOutcome {
  return row === undefined ? "not_found" : null;
}

export interface BatchFailure {
  readonly id: string;
  readonly reason: BatchFailureReason;
}

/**
 * Aplica la decisión id por id, **en el orden del pedido**, para que el cliente pueda
 * emparejar por posición sin buscar por id.
 */
export function collectFailures<TRow>(
  ids: readonly string[],
  rows: ReadonlyMap<string, TRow>,
  decide: (row: TRow | undefined) => BatchOutcome,
): BatchFailure[] {
  const failures: BatchFailure[] = [];
  for (const id of ids) {
    // Un id malformado no puede existir, así que no se consulta: se reporta.
    const reason = isStorableId(id) ? decide(rows.get(id)) : "invalid_id";
    if (reason !== null) failures.push({ id, reason });
  }
  return failures;
}

/**
 * Un `target` del cuerpo de `schedule`, aplanado a las columnas de `posts`.
 *
 * El contrato define cuatro esquemas distintos y sólo comparten una parte: `reddit` ni
 * siquiera tiene la clave `warmedAccountId` (el contrato la quita porque Reddit es sólo
 * OAuth), así que leer el union sin estrecharlo no compila. Estrecharlo una vez acá deja
 * el resto del handler trabajando contra una sola forma.
 *
 * **`title` de TikTok cae en `caption`**: el recurso `Post` (DATA-020) no tiene columna
 * `title`, y FR-060 describe los dos campos de TikTok como el par título/cuerpo, igual que
 * el `caption`/`description` de YouTube. Es una traducción, no un campo nuevo.
 */
export interface FlatTarget {
  /**
   * Se escribe como unión literal y no como `ScheduleTarget["platform"]`: indexar una
   * unión de esquemas envueltos en `refine` colapsa a `any`, y un `any` acá viajaría
   * hasta la columna `post_platform` sin que el compilador dijera nada.
   */
  readonly platform: "tiktok" | "instagram" | "youtube" | "reddit";
  readonly connectionId: string | null;
  readonly warmedAccountId: string | null;
  readonly caption: string | null;
  readonly description: string | null;
  readonly discloseAsAds: boolean | null;
  readonly aiContentDisclaimer: boolean | null;
  readonly instagramSlideshowFormat: "carousel" | "reel" | null;
  readonly postingMode: "inbox" | "direct" | null;
  readonly privacyLevel:
    | "PUBLIC_TO_EVERYONE"
    | "MUTUAL_FOLLOW_FRIENDS"
    | "FOLLOWER_OF_CREATOR"
    | "SELF_ONLY"
    | null;
  readonly tiktokSoundId: string | null;
  readonly tiktokSoundMode: "audible" | "silent" | null;
}

const EMPTY_TARGET = {
  connectionId: null,
  warmedAccountId: null,
  caption: null,
  description: null,
  discloseAsAds: null,
  aiContentDisclaimer: null,
  instagramSlideshowFormat: null,
  postingMode: null,
  privacyLevel: null,
  tiktokSoundId: null,
  tiktokSoundMode: null,
} as const;

export function flattenTarget(target: ScheduleTarget): FlatTarget {
  const shared = {
    ...EMPTY_TARGET,
    connectionId: target.connectionId ?? null,
    discloseAsAds: target.discloseAsAds ?? null,
    aiContentDisclaimer: target.aiContentDisclaimer ?? null,
  };

  switch (target.platform) {
    case "tiktok":
      return {
        ...shared,
        platform: "tiktok",
        warmedAccountId: target.warmedAccountId ?? null,
        caption: target.title ?? null,
        description: target.description ?? null,
        postingMode: target.postingMode ?? null,
        privacyLevel: target.privacyLevel ?? null,
        tiktokSoundId: target.tiktokSoundId ?? null,
        tiktokSoundMode: target.tiktokSoundMode ?? null,
      };
    case "instagram":
      return {
        ...shared,
        platform: "instagram",
        warmedAccountId: target.warmedAccountId ?? null,
        caption: target.caption ?? null,
        instagramSlideshowFormat: target.instagramSlideshowFormat ?? null,
      };
    case "youtube":
      return {
        ...shared,
        platform: "youtube",
        warmedAccountId: target.warmedAccountId ?? null,
        caption: target.caption ?? null,
        description: target.description ?? null,
      };
    default:
      // Reddit. Es la rama por defecto y no un `case` porque su esquema es el único que
      // **no** tiene la clave `warmedAccountId` —el contrato se la quita: FR-060 (PRD:1374)
      // dice que Reddit publica sólo por OAuth—, así que el compilador no puede cerrar el
      // `switch` por exhaustividad sobre una unión con miembros de forma distinta.
      return { ...shared, platform: "reddit", caption: target.caption ?? null };
  }
}

/** Cuenta ya resuelta y validada contra el workspace. */
interface ResolvedAccount {
  readonly accountType: "oauth" | "warmed";
  readonly connectionId: string | null;
  readonly warmedAccountId: string | null;
  readonly connectionUsername: string | null;
}

/** Un fallo de programación que ya sabe con qué status y código sale. */
interface ScheduleRejection {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

type Resolution =
  | { readonly ok: true; readonly account: ResolvedAccount }
  | { readonly ok: false; readonly rejection: ScheduleRejection };

const DAY_MS = 24 * 60 * 60 * 1000;
const WARMED_HORIZON_MS = WARMED_MAX_SCHEDULE_DAYS_AHEAD * DAY_MS;

export function registerPostRoutes(app: ZodApp): void {
  const { limiter, clock, queue } = app.deps;

  // ── GET /posts ──
  app.get(
    "/posts",
    { schema: { querystring: listPostsQuerySchema } },
    async (request) => {
      const q = request.query;

      const result = await request.tx((tx) =>
        postRepository.list(
          tx,
          { companyId: request.auth.companyId },
          {
            limit: q.limit,
            ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
            // §12 (PRD:2723): `status` es una lista separada por comas; el contrato ya la
            // partió y validó contra el enum, así que acá sólo se traduce a un `IN`. El
            // `400 bad_request` que devolvía esta ruta era del tiempo en que filtrar pedía
            // un `SQL` de Drizzle, inalcanzable desde `apps/api`.
            ...(q.status === undefined ? {} : { filter: { status: { in: q.status } } }),
          },
        ),
      );
      return page(result, toPost);
    },
  );

  // ── GET /posts/:id ──
  app.get("/posts/:id", { schema: { params: idParams } }, async (request) => {
    const { id } = request.params;
    const companyId = request.auth.companyId;
    if (!isStorableId(id)) throw notFound("post");

    const row = await request.tx((tx) => postRepository.findById(tx, { companyId }, id));
    if (row === null) throw crossTenant("post", id, companyId);
    return data(toPost(row));
  });

  // ── POST /content/:id/schedule ──
  app.post(
    "/content/:id/schedule",
    {
      schema: { params: idParams, body: scheduleContentRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const { id: contentId } = request.params;
      const body = request.body;
      const companyId = request.auth.companyId;

      // Sin cola no hay *publishing job* (§9.5 punto 8), y un `Post` en `SCHEDULED` que
      // nadie va a publicar es peor que un fallo: se ve bien en la Library y la hora pasa
      // sin que ocurra nada. Mismo trato que `angleGenerator` en `angles.ts`, y por la
      // misma razón — `service_unavailable` es un código del PRD (ERR-R06) y **no se crea
      // ninguna fila**.
      if (queue === undefined) {
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Scheduling is temporarily unavailable.",
          },
        });
      }

      // AI-006 rellena **sólo** los campos vacíos, lo que exige un modelo. Ese adaptador
      // no existe (es el mismo hueco que `angleGenerator`). Se rechaza el pedido entero en
      // vez de ignorar la bandera: ignorarla publicaría captions vacías en silencio, que
      // es exactamente lo que el usuario pidió que no pasara.
      if (body.enableCaptionGeneration === true) {
        return reply.status(503).send({
          error: {
            code: "service_unavailable",
            message: "Caption generation is temporarily unavailable.",
          },
        });
      }

      if (!isStorableId(contentId)) throw notFound("content");

      const scheduledAt = new Date(body.scheduledAtUtc);
      const nowMs = clock.nowMs();

      // Una hora pasada se rechaza, y la razón es de contrato, no de gusto: `startAfter`
      // en el pasado hace que la cola arranque el job **ya**, o sea una "publicar ahora"
      // por la puerta de atrás. F-157 dice que esa opción existe en el producto pero el
      // PRD no nombra su campo, así que el contrato deliberadamente no la expone; dejar
      // que un timestamp viejo —un reintento, un reloj corrido— la dispare publicaría
      // algo que nadie pidió en ese momento.
      if (body.scheduledAtUtc <= nowMs) {
        return reply.status(400).send({
          error: {
            code: "bad_request",
            message: "scheduledAtUtc must be in the future.",
          },
        });
      }

      const targets = body.targets.map(flattenTarget);

      const outcome = await request.tx(async (tx) => {
        const content = await contentRepository.findById(tx, { companyId }, contentId);
        if (content === null) return { kind: "content_missing" as const };

        // FR-060 admite programar contenido en `BUILDING` (el post espera en `BUILDING`
        // hasta que el media esté listo). `FAILED` no lo cubre, y `unsupported_content_state`
        // es el código que el PRD usa para "el contenido está BUILDING o FAILED" (PRD:1202).
        if (content.status === "FAILED") return { kind: "content_failed" as const };

        // FR-060: "Si el contenido aún no está `CREATED`, el post queda en `BUILDING`".
        const status: "SCHEDULED" | "BUILDING" =
          content.status === "CREATED" ? "SCHEDULED" : "BUILDING";

        // La resolución de cuenta y la fila que sale de ella se arman en el mismo paso:
        // llevarlas en dos listas paralelas obligaría a indexar una con el índice de la
        // otra, que es donde un desfase se vuelve un post publicado en la cuenta ajena.
        const values = [];
        for (const target of targets) {
          const resolution = await resolveAccount(tx, companyId, target, {
            scheduledAtMs: body.scheduledAtUtc,
            nowMs,
          });
          if (!resolution.ok) {
            return { kind: "rejected" as const, rejection: resolution.rejection };
          }
          const account = resolution.account;
          values.push({
            contentId: content.id,
            platform: target.platform,
            accountType: account.accountType,
            // El CHECK `posts_account_exclusive` exige **exactamente uno** de los dos no
            // nulo, y `posts_account_type_matches` que sea el que `accountType` nombra.
            // `resolveAccount` es el único sitio que decide cuál, justamente para que no
            // haya una segunda opinión que pueda discrepar con la base.
            connectionId: account.connectionId,
            warmedAccountId: account.warmedAccountId,
            connectionUsername: account.connectionUsername,
            scheduledAtUtc: scheduledAt,
            caption: target.caption,
            description: target.description,
            discloseAsAds: target.discloseAsAds,
            aiContentDisclaimer: target.aiContentDisclaimer,
            instagramSlideshowFormat: target.instagramSlideshowFormat,
            postingMode: target.postingMode,
            privacyLevel: target.privacyLevel,
            tiktokSoundId: target.tiktokSoundId,
            tiktokSoundMode: target.tiktokSoundMode,
            status,
          });
        }

        const rows = await postRepository.createMany(tx, { companyId }, values);

        // ADR-005: el encolado va **dentro** de la transacción que creó las filas. Si el
        // commit se cae, no queda ni post ni job; si la cola se cae, `PortError` aborta la
        // transacción y no quedan posts sin publicador.
        const jobs: JobSpec<{ companyId: string; postId: string }>[] = rows.map(
          (row) => ({
            queue: PUBLISH_POST_QUEUE,
            // Payload mínimo a propósito: el worker relee la fila con su propio scope. Copiar
            // caption, cuenta o privacidad acá los congelaría en el momento de programar, y
            // un `Reschedule` posterior publicaría lo viejo.
            payload: { companyId, postId: row.id },
            options: {
              transaction: tx,
              startAfter: scheduledAt,
              // Un post por fila. La fila es nueva en cada programación, así que esto no
              // deduplica programaciones distintas: deduplica el reintento del mismo
              // encolado si la transacción se reintenta por un deadlock.
              singletonKey: `${PUBLISH_POST_QUEUE}:${row.id}`,
              // Sin reintentos automáticos. `NFR-015` prohíbe duplicar un post y `NFR-005`
              // prohíbe reintentar solo lo no idempotente: un segundo intento después de un
              // timeout del proveedor puede publicar dos veces. El watcher del carril lento
              // (72 h) es el mecanismo de recuperación, no el retry de la cola.
              retryLimit: 0,
            },
          }),
        );
        await queue.enqueueMany(jobs);

        return { kind: "created" as const, rows };
      });

      if (outcome.kind === "content_missing") {
        throw crossTenant("content", contentId, companyId);
      }
      if (outcome.kind === "content_failed") {
        return reply.status(409).send({
          error: {
            code: "unsupported_content_state",
            message: "This content failed to build and cannot be scheduled.",
          },
        });
      }
      if (outcome.kind === "rejected") {
        const { status, code, message, details } = outcome.rejection;
        return reply.status(status).send({
          error: { code, message, ...(details === undefined ? {} : { details }) },
        });
      }

      // `201`: se crearon recursos y el cuerpo son esos recursos. El PRD fija el envelope
      // (§9.3) pero no el status de esta ruta.
      return reply.status(201).send(data(outcome.rows.map(toPost)));
    },
  );

  // ── POST /posts/cancel ──
  app.post(
    "/posts/cancel",
    {
      schema: { body: cancelPostsRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const { postIds } = request.body;
      const companyId = request.auth.companyId;

      const outcome = await request.tx(async (tx) => {
        const rows = await loadBatch(tx, companyId, postIds);
        const failures = collectFailures(postIds, rows, cancelFailureOf);
        if (failures.length > 0) return { kind: "failed" as const, failures };

        // Todo el lote entra en esta transacción. NFR-011 pide "todo o nada" y `request.tx`
        // es lo que lo hace cierto: un fallo a mitad revierte también lo ya escrito.
        const updated = [];
        for (const id of postIds) {
          const row = rows.get(id);
          // `collectFailures` ya descartó los ausentes; si falta acá, cambió el modelo.
          if (row === undefined) throw new Error(`El post ${id} se perdió entre pasos.`);

          const patch = cancelPatchOf(row);
          // Ya estaba cancelado: no se reescribe. Volver a poner `CANCELLED` movería
          // `updatedAt` y diría que algo cambió cuando no cambió nada.
          if (patch === null) {
            updated.push(row);
            continue;
          }

          // El job de publicación **no se cancela acá**, y no por olvido: no guardamos su
          // `jobId` en ninguna columna, así que `Queue.cancel` no es alcanzable. La
          // cancelación vive en la fila, que es lo que hace que el payload del job sea
          // sólo `{companyId, postId}`: el worker relee el post y no publica lo que ya no
          // está `SCHEDULED`. Si algún día se guarda el `jobId`, esto pasa a ser una
          // optimización, no la garantía.
          const next = await postRepository.update(tx, { companyId }, id, patch);
          if (next === null) {
            // La fila estaba dos líneas más arriba, dentro de la misma transacción. Si
            // desapareció, el lote deja de ser atómico: mejor abortar que confirmar medio.
            throw new Error(`El post ${id} desapareció dentro de la propia transacción.`);
          }
          updated.push(next);
        }
        return { kind: "cancelled" as const, rows: updated };
      });

      if (outcome.kind === "failed") return batchRejected(reply, outcome.failures);
      // Se devuelven los posts como quedaron: el cliente ve el estado nuevo sin tener que
      // volver a pedir la lista.
      return reply.status(200).send(data(outcome.rows.map(toPost)));
    },
  );

  // ── POST /posts/delete ──
  app.post(
    "/posts/delete",
    {
      schema: { body: deletePostsRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const { postIds } = request.body;
      const companyId = request.auth.companyId;

      const outcome = await request.tx(async (tx) => {
        const rows = await loadBatch(tx, companyId, postIds);
        const failures = collectFailures(postIds, rows, deleteFailureOf);
        if (failures.length > 0) return { kind: "failed" as const, failures };

        for (const id of postIds) {
          // `posts` no declara `deletedAt`, así que el repositorio sólo ofrece borrado
          // real y `softDelete` tira. Ver la nota del encabezado sobre `status=DELETED`.
          const removed = await postRepository.hardDelete(tx, { companyId }, id);
          if (!removed) {
            throw new Error(`El post ${id} desapareció dentro de la propia transacción.`);
          }
        }
        return { kind: "deleted" as const };
      });

      if (outcome.kind === "failed") return batchRejected(reply, outcome.failures);
      // `204` y no un cuerpo con los ids: el lote es todo o nada, así que lo borrado es
      // exactamente lo pedido y repetirlo no informa nada. Mismo trato que `DELETE /content/:id`.
      return reply.status(204).send();
    },
  );

  // ── POST /analytics/posts ──
  app.post(
    "/analytics/posts",
    { schema: { body: postAnalyticsRequestSchema } },
    async (request, reply) => {
      const { postIds } = request.body;
      const companyId = request.auth.companyId;

      // ERR-F02 (PRD:3201): los ids desconocidos son éxito parcial, pero los **malformados
      // fallan toda la request** con `invalidIds`. Sin esta puerta, un id que no es uuid
      // llega a Postgres y sale como `500`.
      const invalidIds = postIds.filter((id) => !isStorableId(id));
      if (invalidIds.length > 0) {
        return reply.status(400).send({
          error: {
            code: "bad_request",
            message: "Some post ids are not valid identifiers.",
            details: { invalidIds },
          },
        });
      }

      // Los ids ya vienen **deduplicados y capados a 100** por `batchPostIdsSchema`
      // (NFR-012: el orden importa — 150 ids con 60 repetidos son 90 únicos y la llamada
      // es válida). Con ese techo una sola consulta `IN` cubre el lote entero.
      const rows = await request.tx((tx) => loadBatch(tx, companyId, postIds));

      // El orden de la respuesta sigue al del pedido para que el cliente pueda emparejar
      // por posición sin buscar por id.
      return data(
        postIds.map((id) => {
          const row = rows.get(id);
          // Ajeno e inexistente caen los dos acá, indistinguibles (§9.2).
          if (row === undefined) return { _id: id, notFound: true as const };
          return {
            _id: id,
            views: row.views,
            likes: row.likes,
            comments: row.comments,
            ...(row.postUrl === null ? {} : { postUrl: row.postUrl }),
            ...(row.postedAt === null ? {} : { postedAt: row.postedAt.getTime() }),
          };
        }),
      );
    },
  );
}

type PostRow = Awaited<ReturnType<typeof postRepository.create>>;
type Tx = Parameters<typeof postRepository.list>[0];

/**
 * Trae de una sola vez los posts de un lote, indexados por id.
 *
 * Una consulta con `IN` en vez de N `findById`: el filtro declarativo de `packages/db`
 * (`P1-DATA-014`) lo permite sin tocar Drizzle desde acá, y con el techo de 100 ids de
 * NFR-012 el resultado entra en una sola página. Los ids ajenos o inexistentes
 * simplemente no aparecen en el mapa, que es lo que hace indistinguibles los dos casos.
 */
async function loadBatch(
  tx: Tx,
  companyId: string,
  postIds: readonly string[],
): Promise<ReadonlyMap<string, PostRow>> {
  const usable = postIds.filter(isStorableId);
  const result = await postRepository.list(
    tx,
    { companyId },
    { limit: PAGINATION_LIMIT_MAX, filter: { id: { in: usable } } },
  );
  return new Map(result.items.map((row) => [row.id, row]));
}

/**
 * ERR-F01 — el lote no se aplicó y cada id dice por qué.
 *
 * Un único código para todo el lote, y `bad_request` porque es el genérico que el PRD
 * nombra (PRD:1129). Devolver `404` cuando todos los fallos son `not_found` y `409` cuando
 * son de estado convertiría el propio status HTTP en una pista sobre qué ids existen; el
 * motivo por id ya está en `details.failures`, que es donde el PRD lo pone.
 */
function batchRejected(
  reply: FastifyReply,
  failures: readonly BatchFailure[],
): FastifyReply {
  return reply.status(400).send({
    error: {
      code: "bad_request",
      message: "No posts were changed: some ids could not be processed.",
      details: { failures: failures.map((f) => ({ id: f.id, reason: f.reason })) },
    },
  });
}

/**
 * Resuelve contra qué cuenta se publica un `target` — FR-060 (PRD:1373-1383).
 *
 * Todo lo que mira pasa por repositorios scopeados, así que una conexión o una cuenta
 * warmed de otro workspace devuelve `null` y sale como el mismo `404` que una inexistente.
 */
async function resolveAccount(
  tx: Tx,
  companyId: string,
  target: FlatTarget,
  when: { readonly scheduledAtMs: number; readonly nowMs: number },
): Promise<Resolution> {
  if (target.warmedAccountId !== null) {
    return resolveWarmed(tx, companyId, target, when);
  }
  if (target.connectionId !== null) {
    return resolveConnection(tx, companyId, target);
  }
  return resolveSoleConnection(tx, companyId, target);
}

async function resolveWarmed(
  tx: Tx,
  companyId: string,
  target: FlatTarget,
  when: { readonly scheduledAtMs: number; readonly nowMs: number },
): Promise<Resolution> {
  const id = target.warmedAccountId ?? "";
  if (!isStorableId(id)) return rejectNotFound("warmed account");

  const account = await warmedAccountRepository.findById(tx, { companyId }, id);
  if (account === null) return rejectNotFound("warmed account");

  // FR-060: "Warmed accounts sólo soportan `tiktok` e `instagram`". La base tiene el mismo
  // CHECK (`posts_warmed_platform_supported`), y dejarlo llegar hasta ahí convertiría un
  // error del cliente en un `500`.
  if (account.platform !== target.platform) {
    return reject(400, "bad_request", "That warmed account is not on this platform.");
  }

  // FR-130 (PRD:1697): `checking` y `replacement_needed` pausan la publicación. El PRD
  // lista `409 conflict` para "cuenta warmed no activa/finalizada/postable o pausada".
  if (!account.postable || account.postingAvailability !== "available") {
    return reject(409, "conflict", "That warmed account cannot accept posts right now.");
  }

  const lead = when.scheduledAtMs - when.nowMs;
  // El lead time es **de la cuenta**, no el global: FR-060 lo dice con todas las letras y
  // el campo global de `GET /warmed-accounts` existe "sólo por compatibilidad".
  if (lead < account.minLeadTimeMs) {
    return reject(400, "bad_request", "Warmed-account posts need more lead time.", {
      minLeadTimeMs: account.minLeadTimeMs,
    });
  }
  if (lead > WARMED_HORIZON_MS) {
    return reject(
      400,
      "bad_request",
      `Warmed-account posts can only be scheduled up to ${String(WARMED_MAX_SCHEDULE_DAYS_AHEAD)} days ahead.`,
    );
  }

  return {
    ok: true,
    account: {
      accountType: "warmed",
      connectionId: null,
      warmedAccountId: account.warmedAccountId,
      // El handle de una cuenta warmed no es el de una conexión OAuth: `connectionUsername`
      // queda nulo y el cliente lee el username por `GET /warmed-accounts`.
      connectionUsername: null,
    },
  };
}

async function resolveConnection(
  tx: Tx,
  companyId: string,
  target: FlatTarget,
): Promise<Resolution> {
  const id = target.connectionId ?? "";
  if (!isStorableId(id)) return rejectNotFound("connection");

  const connection = await connectionRepository.findById(tx, { companyId }, id);
  if (connection === null) return rejectNotFound("connection");
  if (connection.platform !== target.platform) {
    return reject(400, "bad_request", "That connection is not on this platform.");
  }
  // §19.5: una integración expirada, pausada o revocada no publica. Se corta al programar
  // en vez de dejar el post esperando a una hora en la que va a fallar igual.
  if (connection.status !== "active") {
    return reject(409, "conflict", "That connection is not active.");
  }
  return {
    ok: true,
    account: {
      accountType: "oauth",
      connectionId: connection.id,
      warmedAccountId: null,
      connectionUsername: connection.platformUsername,
    },
  };
}

/**
 * FR-060 (PRD:1373): `connectionId` es opcional **sólo si** el workspace tiene exactamente
 * una conexión activa en esa plataforma; con varias es obligatorio y su ausencia devuelve
 * `connection_ambiguous` con la lista de candidatas.
 */
async function resolveSoleConnection(
  tx: Tx,
  companyId: string,
  target: FlatTarget,
): Promise<Resolution> {
  const candidates = await connectionRepository.list(
    tx,
    { companyId },
    {
      limit: PAGINATION_LIMIT_MAX,
      filter: { platform: { eq: target.platform }, status: { eq: "active" } },
    },
  );

  const only = candidates.items[0];
  if (only === undefined) {
    // El PRD no da un código para "no hay ninguna conexión". No se inventa uno: `bad_request`
    // es del PRD y el mensaje dice qué falta. Queda anotado en el reporte.
    return reject(
      400,
      "bad_request",
      `No active ${target.platform} connection is available in this workspace.`,
    );
  }
  if (candidates.items.length > 1) {
    return reject(
      400,
      "connection_ambiguous",
      `Several ${target.platform} connections are active: pass connectionId.`,
      {
        connections: candidates.items.map((c) => ({
          connectionId: c.id,
          username: c.platformUsername,
        })),
      },
    );
  }

  return {
    ok: true,
    account: {
      accountType: "oauth",
      connectionId: only.id,
      warmedAccountId: null,
      connectionUsername: only.platformUsername,
    },
  };
}

function reject(
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): Resolution {
  return {
    ok: false,
    rejection: { status, code, message, ...(details === undefined ? {} : { details }) },
  };
}

/** El 404 de §9.2: ajeno e inexistente dicen exactamente lo mismo. */
function rejectNotFound(resource: string): Resolution {
  return reject(404, "not_found", `${resource} not found`);
}
