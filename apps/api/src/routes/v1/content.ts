/**
 * Content — las nueve rutas de §9.3 sobre `/content`.
 *
 * Fuente: PRD §9.3, §9.4, §9.8, FR-051, FR-070, AI-004, DATA-008, DATA-009,
 * ERR-P02…ERR-P06.
 *
 * ## Las tres decisiones que gobiernan el archivo entero
 *
 * 1. **Sin cola no se crea la fila.** Una pieza nace en `BUILDING` y sólo sale de
 *    ahí cuando un job la construye. Si `deps.queue` no está montada y la fila se
 *    creara igual, quedaría en `BUILDING` **para siempre** y —lo peor— sin fallar
 *    nunca, así que tampoco dispararía el reembolso del save de `markBuildFailed`.
 *    Por eso las cuatro rutas que encolan responden `503 service_unavailable`
 *    antes de tocar la base. Es el precedente de `angleGenerator` en `angles.ts`,
 *    con la consecuencia que anota `server/types.ts`.
 *
 * 2. **Los códigos de error del contenido no son `DomainErrorCode`.**
 *    `stale_revision`, `unsupported_content_state`, `content_has_linked_posts` y
 *    `content_not_editable` están en `errorCodeSchema` del contrato pero no en
 *    `DOMAIN_ERROR_CODES`, y `http/errors.ts` emite sólo `code` + `message` de
 *    `DomainError.toPublic()`: un `DomainError("conflict", …, {code:"stale_revision"})`
 *    saldría al cable como `conflict` y el cliente no podría distinguir "recargá"
 *    de "borrá los posts". Por eso acá se usa {@link ContentRejection}, que viaja
 *    por el `catch` del handler y se serializa con el código del PRD. Es el mismo
 *    criterio que ya usaba `DELETE /content/:id` con `content_still_building`.
 *
 * 3. **La rechazo va DENTRO de la transacción y de la idempotencia.** Comprobar
 *    las guardas en una transacción y mutar en otra abre una ventana en la que la
 *    `revision` se mueve entre las dos. Acá todo pasa en `request.tx`, y cuando
 *    una guarda falla se lanza: `withIdempotency` libera la key en su `catch`
 *    (regla 3 de §9.3) y el cliente puede reintentar. Un rechazo determinista
 *    nunca debe quemar la key.
 *
 * ## Lo que este archivo NO hace, y por qué
 *
 * - **No cobra content save en `POST /content/custom/video`, ni en las
 *   ediciones.** (Decía que tampoco en `POST /content`; eso dejó de ser cierto
 *   cuando `consumeContentSave` se cableó ahí, con `saveBucket`/`savePeriod`
 *   en la fila.) Las ediciones —`PATCH` y `regenerate`— no cobran por FR-051
 *   (PRD:1186), y por eso encolan en `content-rebuild`, cuyo handler **no
 *   reembolsa** al fallar: el `saveBucket` de la fila es del build original.
 *
 * - **No valida que las URLs del payload pertenezcan al Media Bank** (FR-070,
 *   PRD:1459). La mitad se puede —`media` está scopeado por workspace— pero la
 *   otra mitad, *"o a la librería compartida"*, **no tiene tabla**: el único
 *   catálogo global del schema es `audio_tracks`. Validar sólo contra `media`
 *   devolvería `400` a toda URL legítima de la librería, que es un fallo peor que
 *   el que la validación evita.
 *
 * ## Lo que sí queda garantizado
 *
 * `buildPayload` y `studioState` **nunca** salen por la API (DATA-008). No están
 * en `toContent`, y como el tipo de retorno es explícito, agregarlos sería un
 * error de compilación y no un descuido de revisión. `GET /content/:id/editable`
 * lee `buildPayload` para resolver el `canvas` y devuelve **sólo** el canvas: el
 * payload en sí no cruza.
 */
import { z } from "zod";
import {
  CONTENT_BUILD_DELETE_GRACE_MINUTES,
  CONTENT_TYPE_EXTENSIONS,
  contentBuildPayloadSchema,
  contentTextBoxSchema,
  createContentRequestSchema,
  createCustomVideoContentRequestSchema,
  idempotencyHeaderSchema,
  listContentQuerySchema,
  optionalIdempotencyHeaderSchema,
  regenerateContentRequestSchema,
  updateContentRequestSchema,
  videoUploadReservationRequestSchema,
  type Canvas,
  type ContentBuildPayload,
  type ContentTextBox,
  type EditableContent,
  type UploadReservation,
} from "@fastgram/contracts";
import {
  contentBuildStore,
  contentRepository,
  contentTextBoxRepository,
  postRepository,
  uploadReservationRepository,
  type Transaction,
  type contentTextBoxes,
} from "@fastgram/db";
import { CONTENT_BUILD_QUEUE, JOB_QUEUES } from "@fastgram/core";
import { MAX_SIGNED_URL_TTL_SECONDS, type Queue } from "@fastgram/ports";
import { randomUUID } from "node:crypto";
import type { FastifyReply } from "fastify";

import { rateLimit } from "../../plugins/rate-limit.js";
import { canFinalize } from "../../http/uploads.js";
import { toContent, type ContentResource } from "../../support/serializers.js";
import { consumeContentSave } from "../../support/quota.js";
import { crossTenant, data, idempotencyKeyOf, page, withIdempotency } from "./shared.js";
import type { ZodApp } from "../../server/types.js";

const contentParams = z.object({ id: z.string().min(1) });

/** ERR-P02 (PRD:3184) — margen antes de poder borrar un contenido colgado. */
const BUILD_GRACE_MS = CONTENT_BUILD_DELETE_GRACE_MINUTES * 60 * 1000;

/**
 * Vida de una reserva de subida.
 *
 * El PRD fija los límites de tamaño y de content type de §9.8 pero **no dice
 * cuánto vive la reserva**. Se toma el techo del puerto `Storage`
 * (`MAX_SIGNED_URL_TTL_SECONDS`, 1 h por `NFR-008`) porque es el único número con
 * respaldo: pedir más es `bad_request` en el adaptador, así que cualquier otra
 * elección sería inventar por debajo sin motivo. La fila y la firma caducan a la
 * vez, que es lo que hace que `410 gone` y un PUT rechazado digan lo mismo.
 */
const UPLOAD_RESERVATION_TTL_SECONDS = MAX_SIGNED_URL_TTL_SECONDS;

/**
 * Un rechazo con código del PRD que no tiene `DomainErrorCode`.
 *
 * Ver la decisión 2 de la cabecera. Lleva el status explícito porque el PRD no lo
 * deriva del código: `content_not_editable` y `content_unavailable_for_type` son
 * **422** y el resto de los de contenido son **409** (§19.6).
 */
class ContentRejection extends Error {
  override readonly name = "ContentRejection";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

/** Serializa un `ContentRejection`; el resto de los errores siguen su camino. */
function sendRejection(reply: FastifyReply, e: unknown): FastifyReply | null {
  if (!(e instanceof ContentRejection)) return null;
  return reply.status(e.status).send({
    error: {
      code: e.code,
      message: e.message,
      ...(e.details === undefined ? {} : { details: e.details }),
    },
  });
}

/** §9.6 — "Builds de contenido: 10/min". No hay cola que no esté disponible. */
function queueUnavailable(reply: FastifyReply): FastifyReply {
  return reply.status(503).send({
    error: {
      code: "service_unavailable",
      message: "Content builds are temporarily unavailable.",
    },
  });
}

/**
 * Qué tipo de contenido describe un payload de build.
 *
 * `POST /content` recibe el payload **desnudo**: FR-070 define los cuatro
 * formatos y el contrato los une sin clave discriminante, porque el PRD no la
 * tiene (ver `contentBuildPayloadSchema`). Con `.strict()` en cada rama las
 * cuatro formas son disjuntas, así que el tipo se deduce de qué campos hay. El
 * orden de las comprobaciones importa: `video-hook` tiene `hook_video` y
 * `green-screen` tiene `image` **y** `video`, de modo que preguntar por `video`
 * primero los confundiría con `wall-of-text`.
 */
function contentTypeOf(
  payload: ContentBuildPayload,
): "slideshow" | "video-hook" | "green-screen" | "wall-of-text" {
  if ("num_images" in payload) return "slideshow";
  if ("hook_video" in payload) return "video-hook";
  if ("image" in payload) return "green-screen";
  return "wall-of-text";
}

/**
 * Canvas editable de una pieza, a partir de su `buildPayload`.
 *
 * Devuelve `null` cuando el payload falta o no parsea, que es el caso que
 * ERR-F04 llama *"manifest legacy"*. El slideshow lleva el canvas **por slide**
 * (`slideCanvasSchema`, con `aspectRatio`) y `editableContentSchema.canvas` es el
 * canvas pelado: se toma el del primer slide y se descarta `aspectRatio`, porque
 * el editor dibuja sobre una sola superficie y todos los slides de una pieza
 * comparten formato.
 */
function canvasOf(buildPayload: unknown): Canvas | null {
  const parsed = contentBuildPayloadSchema.safeParse(buildPayload);
  if (!parsed.success) return null;
  const payload = parsed.data;

  if ("num_images" in payload) {
    const first = payload.images[0];
    return first === undefined
      ? null
      : { width: first.canvas.width, height: first.canvas.height };
  }
  return { width: payload.canvas.width, height: payload.canvas.height };
}

/**
 * Fila de `content_text_boxes` → `ContentTextBox` del contrato.
 *
 * Vive acá y no en `support/serializers.ts` porque ese archivo es de otro agente
 * en esta tanda. Se **parsea** con el schema del contrato en vez de castear: las
 * cuatro columnas de geometría y estilo son `jsonb`, que Drizzle tipa como
 * `unknown`, y un `as` haría que una fila escrita por una migración vieja
 * saliera por la API con una forma que el contrato promete y no cumple. Los
 * CHECK del schema cubren los rangos; esto cubre la forma.
 */
function toContentTextBox(row: typeof contentTextBoxes.$inferSelect): ContentTextBox {
  return contentTextBoxSchema.parse({
    id: row.id,
    ...(row.slideIndex === null ? {} : { slideIndex: row.slideIndex }),
    text: row.text,
    position: row.position,
    widthPercent: row.widthPercent,
    font: row.font,
    color: row.color,
    stroke: row.stroke,
    background: row.background ?? null,
  });
}

/** El tope del repositorio (`PAGINATION.limitMax`). Pedir más lo recorta igual. */
const TEXT_BOX_PAGE_SIZE = 100;

/**
 * Todas las cajas de una pieza, no la primera página.
 *
 * Los repositorios paginan y `normalizeLimit` topea en **100** (`PAGINATION.limitMax`
 * de `@fastgram/db`), pero una pieza no tiene tope de cajas: `assertValidTextBoxes`
 * sólo exige que haya al menos una, y un slideshow de 20 slides con seis cajas cada
 * uno ya pasa de 100. Pedir `limit: 100` y quedarse ahí devolvería un canvas al que
 * le faltan cajas —que se ve como una pieza rota, no como una página 2— y haría que
 * el `PATCH` rechazara por "id inexistente" una caja que sí existe. Por eso se
 * recorre el cursor hasta el final.
 */
async function listAllTextBoxes(
  tx: Transaction,
  companyId: string,
  contentId: string,
): Promise<(typeof contentTextBoxes.$inferSelect)[]> {
  const all: (typeof contentTextBoxes.$inferSelect)[] = [];
  let cursor: string | undefined;

  for (;;) {
    const chunk = await contentTextBoxRepository.list(
      tx,
      { companyId },
      {
        filter: { contentId: { eq: contentId } },
        limit: TEXT_BOX_PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      },
    );
    all.push(...chunk.items);

    // `cursor === null` con `hasMore` en true no debería pasar, pero si pasara
    // el bucle no tendría por dónde avanzar: se corta en vez de girar para siempre.
    if (!chunk.hasMore || chunk.cursor === null) return all;
    cursor = chunk.cursor;
  }
}

/** Qué disparó el build. El worker decide con esto si construye o rehace. */
type BuildReason = "create" | "edit" | "regenerate" | "custom-video";

/**
 * Payload del job de build para las piezas que **no** vienen de Blitz.
 *
 * Tiene la forma de `ContentBuildJob` de `core` (`jobs/content-build.ts`), que
 * es con la que el worker lo parsea. Las piezas nuevas van a `content-build`
 * ({@link enqueueBuild}); las ediciones, a `content-rebuild`
 * ({@link enqueueRebuild}), que §9.5 #4 lista como trabajo propio y cuyo
 * handler cierra un fallo **sin reembolsar** y sin matar la pieza.
 */
interface ContentBuildRequest {
  readonly companyId: string;
  readonly contentId: string;
  readonly contentType: string;
  readonly revision: number;
  readonly reason: BuildReason;
  /** AI-004 — prompt opcional de `Regenerate Text`. */
  readonly prompt?: string;
  readonly mentionBusiness?: boolean;
}

/**
 * Encola el build **dentro de la transacción del llamador** (ADR-005, IMPL §2.3).
 *
 * `singletonKey` lleva la `revision` además del id de la pieza. La versión de
 * Blitz sólo lleva el id porque ahí cada aceptación crea una pieza nueva; acá la
 * misma pieza se rehace muchas veces, y con la clave sin revisión el segundo
 * rebuild se deduplicaría contra el primero y la edición no se aplicaría nunca.
 */
async function enqueueBuild(
  queue: Queue,
  tx: Transaction,
  job: ContentBuildRequest,
): Promise<void> {
  await queue.enqueue<ContentBuildRequest>({
    queue: CONTENT_BUILD_QUEUE,
    payload: job,
    options: {
      transaction: tx,
      singletonKey: `${CONTENT_BUILD_QUEUE}:${job.contentId}:${job.revision}`,
      retryLimit: 2,
      retryBackoff: true,
    },
  });
}

/**
 * Encola el rebuild de una edición — §9.5 #4, `FR-051` — **dentro de la
 * transacción del llamador**, igual que el build.
 *
 * ## La clave: `<contentId>:<revision>`, y por qué no se repite
 *
 * La trampa 45 fue una clave con un contador **que volvía a 1**, y la 39 una
 * clave fija: el adaptador de pg-boss deriva el id del job de la clave, así que
 * una clave repetida choca contra el job viejo —ya completado— y **no encola
 * nada**. Acá eso deja la pieza en `BUILDING` para siempre.
 *
 * `revision` no es un contador que se reinicia: es una columna de la fila que
 * **sólo sube** (la única escritura es `row.revision + 1` en
 * {@link bumpAndRebuild}), y la fila no se recrea con el mismo id. Lo que sí
 * podía repetirla era la carrera: dos `PATCH` simultáneos con la misma
 * `revision` leían los dos N sin bloqueo, pasaban `stale_revision` y escribían
 * los dos N+1. Por eso las dos rutas leen ahora con `lockContent` (`FOR
 * UPDATE`): el segundo espera, ve N+1 y recibe `409 stale_revision`. Con eso,
 * cada edición aceptada tiene una `revision` propia y la clave es única por
 * edición.
 *
 * Se prefirió a meter el instante o un UUID porque la clave además **dice**
 * algo: un job por revisión, que es exactamente lo que el handler construye
 * (compara `revision` al leer y al escribir). Con un UUID, dos jobs para la
 * misma revisión serían encolables y el segundo trabajaría de más.
 *
 * ## Y se mira `created`
 *
 * La otra mitad de la trampa 45: quien encola y no mira `created` no se entera
 * de que no encoló. Si alguna vez la clave se repitiera, esto lanza y la
 * transacción entera vuelve atrás —la revisión, las cajas, el `BUILDING`—, en
 * vez de responder 200 con una pieza que nadie va a reconstruir.
 */
async function enqueueRebuild(
  queue: Queue,
  tx: Transaction,
  job: ContentBuildRequest,
): Promise<void> {
  const singletonKey = `${JOB_QUEUES.contentRebuild}:${job.contentId}:${job.revision}`;
  const { created } = await queue.enqueue<ContentBuildRequest>({
    queue: JOB_QUEUES.contentRebuild,
    payload: job,
    options: {
      transaction: tx,
      singletonKey,
      // 2 reintentos = 3 intentos, el `maxAttempts` del catálogo del worker.
      retryLimit: 2,
      retryBackoff: true,
    },
  });
  if (!created) {
    throw new Error(
      `content-rebuild no encoló: la clave ${singletonKey} ya tenía un job. ` +
        "La pieza quedaría en BUILDING sin nadie que la reconstruya.",
    );
  }
}

/** Fila de `contents` tal como la devuelve el repositorio. */
type ContentRow = Awaited<ReturnType<typeof contentRepository.findById>>;
type LiveContentRow = NonNullable<ContentRow>;

/**
 * Las guardas de edición de FR-051, en el orden del PRD.
 *
 * El orden es el de `core/content/edit-content.ts` y está argumentado ahí: la
 * `revision` se comprueba **primero** porque un cliente desactualizado puede
 * estar equivocado sobre todo lo demás, incluido el motivo por el que no puede
 * editar. Cualquier otro mensaje lo manda a resolver un problema que quizá ya no
 * existe.
 *
 * `expectedRevision` es `undefined` en `POST /content/:id/regenerate`:
 * `regenerateContentRequestSchema` **no lleva `revision`**. No es un olvido del
 * contrato —AI-004 tampoco la menciona— y queda reportado: hoy regenerar sobre
 * una pieza que alguien acaba de editar no da `stale_revision`.
 */
async function assertEditable(
  tx: Transaction,
  companyId: string,
  row: LiveContentRow,
  boxCount: number,
  expectedRevision: number | undefined,
): Promise<void> {
  if (expectedRevision !== undefined && row.revision !== expectedRevision) {
    throw new ContentRejection(
      409,
      "stale_revision",
      "Someone else changed this piece. Reload to get the latest version.",
      { expected: expectedRevision, actual: row.revision },
    );
  }

  // ERR-P05 (422). El PRD: *"Contenido creado vía POST /content (payload
  // explícito) no es editable en el Studio"*. `contents` no tiene columna
  // `editable`, así que la condición se lee de lo que sí está: una pieza sin
  // cajas de texto no tiene nada que este endpoint sepa editar, y `POST /content`
  // crea exactamente eso — su payload trae geometría de canvas en píxeles
  // (`x`, `y`, `fontSize`), no cajas en unidades de editor (0–100, 25–100), y
  // convertir entre las dos sería inventar un mapeo que el PRD no da.
  if (boxCount === 0) {
    throw new ContentRejection(
      422,
      "content_not_editable",
      "This piece can't be edited here. Send an adjusted payload instead.",
    );
  }

  // ERR-P03 y el `409 unsupported_content_state` de FR-051 comparten síntoma en
  // la base: las dos son `status = BUILDING`. `contents` no tiene
  // `editInProgress`, así que no se pueden distinguir sin inventar la columna.
  // Se emite el código que cubre los dos estados que el PRD nombra —BUILDING y
  // FAILED— y queda reportado.
  if (row.status !== "CREATED") {
    throw new ContentRejection(
      409,
      "unsupported_content_state",
      row.status === "BUILDING"
        ? "This piece is still building. Try again when it's ready."
        : "This piece failed to build, so there's nothing to edit.",
      { status: row.status },
    );
  }

  // ERR-P06: *"cancelar no basta, hay que borrarlos"*. Se cuenta en la misma
  // transacción que la edición: contarlos antes, fuera, dejaría pasar una
  // edición sobre una pieza a la que se le acaba de programar un post.
  const linkedPosts = await countLinkedPosts(tx, companyId, row.id);
  if (linkedPosts > 0) {
    throw linkedPostsRejection(linkedPosts, "editing");
  }
}

/**
 * Cuántos posts apuntan a esta pieza — el criterio **único** de ERR-P06.
 *
 * Existe como función y no como dos consultas parecidas porque `PATCH`,
 * `regenerate` y `DELETE` tienen que contestar lo mismo a *"¿esta pieza tiene
 * posts enlazados?"*, y el modo de que se separen es justamente que cada ruta
 * escriba su propio filtro. Lo que cuenta, dicho explícito para que no se
 * reinvente:
 *
 *  - **Todos los estados.** No hay filtro por `status`, así que un post
 *    `CANCELLED` cuenta igual que uno `SCHEDULED`. Es literal de FR-051
 *    (PRD:1201) y de FLOW-008 (PRD:1984): *"hay que **borrar** los posts
 *    (cancelarlos no basta)"*. Agregar acá un `status != 'CANCELLED'` es
 *    exactamente el bug que el PRD nombra.
 *  - **Todas las filas.** `posts` no tiene `deletedAt` —el soft-delete es de
 *    `contents`, `media` y `leads`, ver `_shared.ts`— así que borrar el post es
 *    un `DELETE` de verdad y la cuenta baja. Si algún día `posts` lo adquiere,
 *    esta función tiene que seguir contando sólo los vivos o `DELETE /content`
 *    se vuelve imposible después del primer post.
 *
 * Se llama **dentro** de la transacción de la operación. Contar antes, fuera,
 * deja una ventana en la que alguien programa un post entre la cuenta y la
 * escritura.
 */
async function countLinkedPosts(
  tx: Transaction,
  companyId: string,
  contentId: string,
): Promise<number> {
  return postRepository.count(
    tx,
    { companyId },
    { filter: { contentId: { eq: contentId } } },
  );
}

/** El `409` de ERR-P06, con el verbo de la operación que lo disparó. */
function linkedPostsRejection(
  count: number,
  action: "editing" | "deleting",
): ContentRejection {
  return new ContentRejection(
    409,
    "content_has_linked_posts",
    `Delete the posts linked to this piece before ${action} it.`,
    { linkedPostCount: count },
  );
}

/**
 * Deja la pieza en `BUILDING` con `revision + 1` y encola el rebuild.
 *
 * FR-051: *"no crean una nueva fila de contenido, no consumen content save, no
 * generan un evento de facturación"*. Es un `update` sobre el mismo `_id` y no
 * toca ningún ledger — el día que alguien lo convierta en un `create`, la pieza
 * se duplica en Library, los `Post` quedan apuntando a la versión vieja y cada
 * corrección de una coma cobra un save.
 *
 * `files` **no se limpia**: el PRD dice que durante el rebuild *"el contenido
 * previo sigue usable"*.
 */
async function bumpAndRebuild(
  tx: Transaction,
  queue: Queue,
  companyId: string,
  row: LiveContentRow,
  edit: { readonly kind: "minor" | "regenerate"; readonly atMs: number },
  job: Omit<ContentBuildRequest, "companyId" | "contentId" | "contentType" | "revision">,
): Promise<ContentResource> {
  const revision = row.revision + 1;
  const updated = await contentRepository.update(tx, { companyId }, row.id, {
    revision,
    status: "BUILDING",
    // `lastEdit` es un objeto opaco en el contrato (`z.record`). La fecha va en
    // ms epoch y no como `Date` para que el JSON guardado hable el mismo
    // dialecto que el resto de la API, donde toda fecha sale en ms.
    lastEdit: { at: edit.atMs, outcome: "applied", kind: edit.kind },
  });

  if (updated === null) {
    // El `findById` de arriba la encontró en esta misma transacción. Llegar acá
    // significa que la fila se borró entremedio: mismo 404 que un id inventado.
    throw new ContentRejection(404, "not_found", "content not found");
  }

  await enqueueRebuild(queue, tx, {
    companyId,
    contentId: row.id,
    contentType: row.type,
    revision,
    ...job,
  });

  return toContent(updated);
}

export function registerContentRoutes(app: ZodApp): void {
  const { limiter, clock, idempotency, storage, queue } = app.deps;

  // ── GET /content ──
  app.get(
    "/content",
    { schema: { querystring: listContentQuerySchema } },
    async (request, reply) => {
      const q = request.query;

      // §12: `type` y `status` llegan como listas separadas por comas y el
      // contrato ya las parsea a arrays. El filtro declarativo de `packages/db`
      // cruza la frontera sin Drizzle, que es lo que antes obligaba al `400` de
      // `unsupportedFilter`. `{ in: [] }` no puede llegar: el contrato exige
      // `min(1)` en cada lista.
      const result = await request.tx((tx) =>
        contentRepository.list(
          tx,
          { companyId: request.auth.companyId },
          {
            limit: q.limit,
            ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
            filter: {
              type: q.type === undefined ? undefined : { in: q.type },
              status: q.status === undefined ? undefined : { in: q.status },
            },
          },
        ),
      );
      return reply.send(page(result, toContent));
    },
  );

  // ── POST /content ──
  app.post(
    "/content",
    {
      schema: {
        body: createContentRequestSchema,
        headers: idempotencyHeaderSchema,
      },
      preHandler: [
        rateLimit(limiter, "restPerWorkspace"),
        // §9.6 tiene un límite propio para los builds (10/min) además del global.
        // Se cobran los dos: una petición que construye cuenta en las dos cuentas.
        rateLimit(limiter, "contentBuilds"),
      ],
    },
    async (request, reply) => {
      if (queue === undefined) return queueUnavailable(reply);

      const body = request.body;
      const companyId = request.auth.companyId;
      const type = contentTypeOf(body);

      return withIdempotency(
        idempotency,
        request,
        reply,
        {
          key: idempotencyKeyOf(request.headers),
          route: "POST /content",
          body,
          successStatus: 201,
        },
        () =>
          request.tx(async (tx) => {
            // **Antes de crear y antes de encolar** — el PRD lo pide literal
            // (§9.4): *"reserva la allowance antes de la generación del modelo,
            // y la libera si falla"*. Cobrar después dejaría trabajo hecho y no
            // pagado si algo se cae en el medio. Si no alcanza, lanza
            // `content_quota_exceeded`, que sale como `402` (§19.8).
            const save = await consumeContentSave(tx, { companyId }, clock);

            const row = await contentRepository.create(
              tx,
              { companyId },
              {
                type,
                status: "BUILDING",
                // DATA-008 lo marca como nunca devuelto por la API; se guarda
                // porque es lo único que el worker necesita para construir.
                buildPayload: body,
                // De qué bucket salió y a qué período: `refundSave` devuelve
                // **al bucket del que salió** y al ledger que lo cobró. Los tres
                // buckets tienen precio distinto (`FR-050`), y el período se
                // guarda porque derivarlo depende del ancla, que puede cambiar.
                saveBucket: save.bucket,
                savePeriod: save.period,
              },
            );

            // Último, y en la misma transacción: si la cola no responde, el
            // `throw` aborta el INSERT y no queda una pieza sin trabajo (ADR-005).
            await enqueueBuild(queue, tx, {
              companyId,
              contentId: row.id,
              contentType: row.type,
              revision: row.revision,
              reason: "create",
            });

            return toContent(row);
          }),
      );
    },
  );

  // ── GET /content/:id ──
  app.get("/content/:id", { schema: { params: contentParams } }, async (request) => {
    const { id } = request.params;
    const companyId = request.auth.companyId;
    const row = await request.tx((tx) =>
      contentRepository.findById(tx, { companyId }, id),
    );
    // Ajeno e inexistente devuelven el mismo `null` desde el repositorio, y el mismo
    // 404 desde acá. Son indistinguibles a propósito (§9.2).
    if (row === null) throw crossTenant("content", id, companyId);
    return data(toContent(row));
  });

  // ── GET /content/:id/editable ──
  app.get(
    "/content/:id/editable",
    { schema: { params: contentParams } },
    async (request, reply) => {
      const { id } = request.params;
      const companyId = request.auth.companyId;

      const found = await request.tx(async (tx) => {
        const row = await contentRepository.findById(tx, { companyId }, id);
        if (row === null) return null;

        // Listar las cajas **de este contenido**: el filtro declarativo de
        // `P1-DATA-014` es lo que desbloqueó esta ruta. El scope sigue yendo por
        // separado, así que el `contentId` no puede usarse para salir del workspace.
        const boxes = await listAllTextBoxes(tx, companyId, row.id);
        return { row, boxes };
      });

      if (found === null) throw crossTenant("content", id, companyId);

      const canvas = canvasOf(found.row.buildPayload);
      if (canvas === null) {
        // ERR-P05 (422): *"tipo/origen/payload legacy no soportado"*. Sin canvas
        // no hay superficie sobre la que colocar una caja, así que devolver
        // `textBoxes` sueltas sería darle al editor coordenadas relativas a nada.
        return reply.status(422).send({
          error: {
            code: "content_not_editable",
            message: "This piece has no editable layout.",
          },
        });
      }

      const editable: EditableContent = {
        canvas,
        textBoxes: found.boxes.map(toContentTextBox),
      };
      return reply.send(data(editable));
    },
  );

  // ── PATCH /content/:id ──
  app.patch(
    "/content/:id",
    {
      schema: {
        params: contentParams,
        body: updateContentRequestSchema,
        headers: idempotencyHeaderSchema,
      },
      preHandler: [
        rateLimit(limiter, "restPerWorkspace"),
        rateLimit(limiter, "contentBuilds"),
      ],
    },
    async (request, reply) => {
      if (queue === undefined) return queueUnavailable(reply);

      const { id } = request.params;
      const body = request.body;
      const companyId = request.auth.companyId;

      try {
        return await withIdempotency(
          idempotency,
          request,
          reply,
          {
            key: idempotencyKeyOf(request.headers),
            route: "PATCH /content/:id",
            body,
            successStatus: 200,
          },
          () =>
            request.tx(async (tx) => {
              // `lockContent` y no `findById`: el `FOR UPDATE` serializa dos
              // ediciones de la misma pieza, y es lo que hace que la
              // comprobación de `revision` valga y que la clave del rebuild
              // no se repita. Ver {@link enqueueRebuild}.
              const row = await contentBuildStore.lockContent(tx, { companyId }, id);
              if (row === null) {
                throw new ContentRejection(404, "not_found", "content not found");
              }

              const existing = await listAllTextBoxes(tx, companyId, row.id);

              await assertEditable(tx, companyId, row, existing.length, body.revision);

              // FR-051: *"Se rechazan … IDs inexistentes … **sin aplicar ningún
              // cambio**"*. Por eso la validación es una pasada completa antes de
              // la primera escritura. Los ids duplicados y el array vacío los
              // rechaza `updateContentRequestSchema` antes de llegar acá.
              const known = new Set(existing.map((b) => b.id));
              const unknown = body.textBoxes
                .map((b) => b.id)
                .filter((boxId) => !known.has(boxId));
              if (unknown.length > 0) {
                throw new ContentRejection(
                  400,
                  "bad_request",
                  "Some text boxes aren't in this piece.",
                  { unknownTextBoxIds: unknown },
                );
              }

              for (const box of body.textBoxes) {
                // `upsert` y no `update`: la PK de `content_text_boxes` es
                // `(contentId, id)` y `update` filtra sólo por `id`. Dos piezas
                // del MISMO workspace pueden tener las dos una caja
                // `slide-0-text-0`, así que un `update` escribiría en las dos. El
                // `upsertTarget` del repositorio resuelve por el par.
                const written = await contentTextBoxRepository.upsert(
                  tx,
                  { companyId },
                  {
                    id: box.id,
                    contentId: row.id,
                    ...(box.slideIndex === undefined
                      ? {}
                      : { slideIndex: box.slideIndex }),
                    text: box.text,
                    position: box.position,
                    widthPercent: box.widthPercent,
                    font: box.font,
                    color: box.color,
                    stroke: box.stroke,
                    background: box.background,
                  },
                );
                if (written === null) {
                  // `null` = la fila existe en otro workspace. No debería pasar
                  // (la pieza ya se resolvió con scope), pero si pasa es una fuga
                  // cruzada y tiene que salir como el 404 de §9.2, no como un 500.
                  throw new ContentRejection(404, "not_found", "content not found");
                }
              }

              return bumpAndRebuild(
                tx,
                queue,
                companyId,
                row,
                { kind: "minor", atMs: clock.nowMs() },
                { reason: "edit" },
              );
            }),
        );
      } catch (e) {
        const rejected = sendRejection(reply, e);
        if (rejected !== null) return rejected;
        throw e;
      }
    },
  );

  // ── POST /content/:id/regenerate ──
  app.post(
    "/content/:id/regenerate",
    {
      schema: {
        params: contentParams,
        body: regenerateContentRequestSchema,
        headers: idempotencyHeaderSchema,
      },
      preHandler: [
        rateLimit(limiter, "restPerWorkspace"),
        rateLimit(limiter, "contentBuilds"),
      ],
    },
    async (request, reply) => {
      // No hace falta adaptador de LLM acá, al revés que en
      // `POST /blitz/angles/generate`: AI-004 reescribe la copy y **rehace la
      // pieza**, y §9.5 #4 pone ese trabajo en la cola `content-rebuild`. La
      // ruta sólo valida, sube la `revision` y encola. **Hoy el worker no tiene
      // modelo de copy**: el rebuild cierra la regeneración como fallida
      // (`lastEdit.outcome = "failed"`) y la pieza vuelve a `CREATED` con su
      // versión anterior — ver `apps/worker/src/content/rebuild-handler.ts`.
      if (queue === undefined) return queueUnavailable(reply);

      const { id } = request.params;
      const body = request.body;
      const companyId = request.auth.companyId;

      try {
        return await withIdempotency(
          idempotency,
          request,
          reply,
          {
            key: idempotencyKeyOf(request.headers),
            route: "POST /content/:id/regenerate",
            body,
            successStatus: 200,
          },
          () =>
            request.tx(async (tx) => {
              // `lockContent` y no `findById`: el `FOR UPDATE` serializa dos
              // ediciones de la misma pieza, y es lo que hace que la
              // comprobación de `revision` valga y que la clave del rebuild
              // no se repita. Ver {@link enqueueRebuild}.
              const row = await contentBuildStore.lockContent(tx, { companyId }, id);
              if (row === null) {
                throw new ContentRejection(404, "not_found", "content not found");
              }

              const boxes = await contentTextBoxRepository.count(
                tx,
                { companyId },
                { filter: { contentId: { eq: row.id } } },
              );

              // Sin `revision` en el contrato no hay concurrencia optimista acá.
              // Ver la nota de `assertEditable`.
              await assertEditable(tx, companyId, row, boxes, undefined);

              return bumpAndRebuild(
                tx,
                queue,
                companyId,
                row,
                { kind: "regenerate", atMs: clock.nowMs() },
                {
                  reason: "regenerate",
                  ...(body.prompt === undefined ? {} : { prompt: body.prompt }),
                  ...(body.mentionBusiness === undefined
                    ? {}
                    : { mentionBusiness: body.mentionBusiness }),
                },
              );
            }),
        );
      } catch (e) {
        const rejected = sendRejection(reply, e);
        if (rejected !== null) return rejected;
        throw e;
      }
    },
  );

  // ── POST /content/custom/video/upload-url ──
  app.post(
    "/content/custom/video/upload-url",
    {
      schema: { body: videoUploadReservationRequestSchema },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const body = request.body;
      const companyId = request.auth.companyId;
      const { apiKeyId } = request.auth;

      // El `uploadId` se genera acá en vez de dejarlo al `defaultRandom()` de la
      // columna porque `storageKey` lo lleva dentro y es `NOT NULL`: con el id de
      // la base habría que insertar con una clave provisional y corregirla
      // después, y entre las dos sentencias la fila apuntaría a un objeto que no
      // es el suyo.
      //
      // El `filename` del cliente **no** entra en la clave: es texto que elige
      // quien sube, y con él dentro un `../` o un `%00` viajan hasta el bucket y
      // el nombre del objeto deja de ser nuestro. El nombre original se guarda en
      // la fila, que es donde sirve. La extensión sale del content type, que el
      // schema ya acotó al enum de §9.8.
      const uploadId = randomUUID();
      const extension = CONTENT_TYPE_EXTENSIONS[body.contentType]?.[0] ?? "";
      const storageKey = `content/custom-video/${companyId}/${uploadId}${extension}`;

      // La firma se pide ANTES del INSERT. Si fallara después, quedaría una
      // reserva `reserved` para una URL que el cliente nunca recibió y que sólo
      // puede caducar. Al revés, una URL firmada sin fila es inerte: la
      // finalización exige la reserva y responde 404 sin ella.
      const presigned = await storage.createUploadUrl({
        key: storageKey,
        contentType: body.contentType,
        sizeBytes: body.sizeBytes,
        ttlSeconds: UPLOAD_RESERVATION_TTL_SECONDS,
      });

      await request.tx((tx) =>
        uploadReservationRepository.create(
          tx,
          { companyId },
          {
            uploadId,
            ...(apiKeyId === undefined ? {} : { apiKeyId }),
            filename: body.filename,
            contentType: body.contentType,
            sizeBytes: body.sizeBytes,
            storageKey,
            expiresAt: presigned.expiresAt,
            state: "reserved",
          },
        ),
      );

      // §9.8 fija la forma literal de la respuesta. `storageKey` no está en ella
      // y no puede estarlo (NFR-007: *"storage keys e ids internos nunca se
      // devuelven"*); que el tipo de retorno sea `UploadReservation` lo convierte
      // en un error de compilación si alguien lo agrega.
      const reservation: UploadReservation = {
        uploadId: uploadId as UploadReservation["uploadId"],
        uploadUrl: presigned.url,
        method: "PUT",
        headers: { ...presigned.headers },
        expiresAt: presigned.expiresAt.getTime(),
      };
      return reply.status(201).send(data(reservation));
    },
  );

  // ── POST /content/custom/video ──
  app.post(
    "/content/custom/video",
    {
      schema: {
        body: createCustomVideoContentRequestSchema,
        // §9.3 exige `Idempotency-Key` en cuatro rutas y ésta no es una de ellas,
        // pero `NFR-004` la quiere en toda operación facturable y ésta cuesta
        // `usage`. Se resuelve como en `FR-050`: **sin key la operación no es
        // idempotente, con key sí**. Exigirla inventaría un requisito; ignorarla
        // desperdiciaría el único mecanismo que evita cobrar dos veces.
        headers: optionalIdempotencyHeaderSchema,
      },
      preHandler: [
        rateLimit(limiter, "restPerWorkspace"),
        rateLimit(limiter, "contentBuilds"),
      ],
    },
    async (request, reply) => {
      if (queue === undefined) return queueUnavailable(reply);

      const body = request.body;
      const companyId = request.auth.companyId;
      const key = idempotencyKeyOf(request.headers);

      const finalize = (): Promise<ContentResource> =>
        request.tx(async (tx) => {
          const row = await uploadReservationRepository.findById(
            tx,
            { companyId },
            body.uploadId,
          );

          // `canFinalize` comprueba el tenant antes que la expiración para que un
          // `410` no confirme que el uploadId existe. Acá esa trampa ni siquiera
          // se puede pisar: el repositorio ya filtró por `companyId`, así que una
          // reserva ajena llega como `null` y sale como el mismo 404 que un id
          // inventado. Se usa igual la función para no duplicar la política.
          const outcome = canFinalize(
            row === null
              ? null
              : {
                  uploadId: row.uploadId,
                  companyId: row.companyId,
                  status: row.state,
                  expiresAtMs: row.expiresAt.getTime(),
                },
            { companyId },
            clock.nowMs(),
          );

          if (outcome.kind === "not_found") {
            throw new ContentRejection(404, "not_found", "upload not found");
          }
          if (outcome.kind === "gone") {
            throw new ContentRejection(
              410,
              "gone",
              "This upload reservation expired. Reserve a new one.",
            );
          }
          if (outcome.kind === "conflict") {
            throw new ContentRejection(409, "conflict", outcome.reason);
          }
          if (row === null) {
            // Inalcanzable: `canFinalize(null, …)` devuelve `not_found`. Está
            // para que el compilador no necesite un `!` en las líneas de abajo.
            throw new ContentRejection(404, "not_found", "upload not found");
          }

          // Se marca `finalizing` primero. Si algo de lo que sigue falla, la
          // transacción vuelve atrás y la reserva queda `reserved`, que es
          // reintentable; dejarla en `finalizing` la mataría con un 409 eterno.
          await uploadReservationRepository.update(tx, { companyId }, row.uploadId, {
            state: "finalizing",
          });

          // §9.8 paso 3: *"verifica el objeto antes de finalizar"*. `head` devuelve
          // `null` cuando el cliente todavía no hizo el PUT, y el PRD traduce ese
          // caso a `409 conflict` — no a un fallo de infraestructura.
          const object = await storage.head(row.storageKey);
          if (object === null) {
            throw new ContentRejection(
              409,
              "conflict",
              "The uploaded file isn't reachable yet. Finish the upload and retry.",
            );
          }

          const content = await contentRepository.create(
            tx,
            { companyId },
            {
              // `custom` es, literalmente, *"el de POST /content/custom/video"*
              // (`CONTENT_TYPES` en core).
              type: "custom",
              // MOV→MP4 y el thumbnail los hace un job (§9.5 #7 y FR-070,
              // PRD:1463): la pieza nace en `BUILDING` aunque el archivo ya esté
              // subido, porque todavía no hay nada publicable.
              status: "BUILDING",
            },
          );

          await uploadReservationRepository.update(tx, { companyId }, row.uploadId, {
            state: "committed",
          });

          await enqueueBuild(queue, tx, {
            companyId,
            contentId: content.id,
            contentType: content.type,
            revision: content.revision,
            reason: "custom-video",
          });

          return toContent(content);
        });

      try {
        if (key === "") {
          return reply.status(201).send(data(await finalize()));
        }
        return await withIdempotency(
          idempotency,
          request,
          reply,
          {
            key,
            route: "POST /content/custom/video",
            body,
            successStatus: 201,
          },
          finalize,
        );
      } catch (e) {
        const rejected = sendRejection(reply, e);
        if (rejected !== null) return rejected;
        throw e;
      }
    },
  );

  // ── DELETE /content/:id ──
  app.delete(
    "/content/:id",
    {
      schema: { params: contentParams },
      preHandler: rateLimit(limiter, "restPerWorkspace"),
    },
    async (request, reply) => {
      const { id } = request.params;
      const companyId = request.auth.companyId;

      const outcome = await request.tx(async (tx) => {
        const row = await contentRepository.findById(tx, { companyId }, id);
        if (row === null) return { kind: "not_found" as const };

        // ERR-P02: un contenido en `BUILDING` se puede borrar **pasados 15 minutos**.
        // Antes de eso el build sigue vivo y borrarlo dejaría el job huérfano.
        if (
          row.status === "BUILDING" &&
          clock.nowMs() - row.createdAt.getTime() < BUILD_GRACE_MS
        ) {
          return { kind: "building" as const };
        }

        // ERR-P06 en el borrado — **esto faltaba**, y era un agujero real.
        //
        // El 409 vivía sólo en `assertEditable`, así que `PATCH` y `regenerate` lo
        // comprobaban y `DELETE` no: se podía borrar una pieza con posts
        // programados apuntándola. La tabla de dependencias del PRD (§20,
        // PRD:3317) dice *"Borrar contenido · Sin posts vinculados ·
        // `409 content_has_linked_posts`"*, o sea que el borrado tiene la misma
        // precondición que la edición y no una más laxa.
        //
        // El criterio es **el mismo** a propósito y por eso sale de la misma
        // función (ver {@link countLinkedPosts}): un post `CANCELLED` sigue
        // contando. Si las dos rutas respondieran distinto, cancelar los posts
        // dejaría borrar la pieza pero no editarla, que es exactamente la
        // asimetría que FLOW-008 (PRD:1984) niega.
        //
        // Va **después** de la ventana de ERR-P02 porque el de 15 minutos es el
        // más específico: una pieza que todavía se está construyendo no debería
        // recibir "borrá los posts" como explicación de por qué no se puede
        // borrar todavía. Y va **dentro** de la transacción del `softDelete`, no
        // antes, para que no quede una ventana entre contar y borrar.
        const linkedPosts = await countLinkedPosts(tx, companyId, id);
        if (linkedPosts > 0) {
          return { kind: "linked_posts" as const, count: linkedPosts };
        }

        await contentRepository.softDelete(tx, { companyId }, id);
        return { kind: "deleted" as const };
      });

      if (outcome.kind === "not_found") throw crossTenant("content", id, companyId);
      if (outcome.kind === "building") {
        return reply.status(409).send({
          error: {
            code: "content_still_building",
            message: `Content that is still building can be deleted after ${CONTENT_BUILD_DELETE_GRACE_MINUTES} minutes.`,
          },
        });
      }
      if (outcome.kind === "linked_posts") {
        const rejected = sendRejection(
          reply,
          linkedPostsRejection(outcome.count, "deleting"),
        );
        // `sendRejection` sólo devuelve `null` para algo que no es un
        // `ContentRejection`, y lo de arriba lo es. El `throw` es para que el día
        // que alguien cambie la fábrica, el compilador y el runtime lo digan en
        // vez de devolver un cuerpo vacío con 200.
        if (rejected === null) throw new Error("sendRejection no serializó ERR-P06");
        return rejected;
      }
      return reply.status(204).send();
    },
  );
}

/**
 * Las piezas puras de este archivo, para el test.
 *
 * Se exponen acá y no una por una porque no son API de la ruta: son detalles que
 * el test necesita poder fijar sin levantar Fastify ni Postgres. `vitest.config`
 * de `apps/api` excluye los `.int.test.ts` justamente para que la suite unitaria
 * siga dando señal en una máquina sin Docker.
 */
export const __testables = {
  contentTypeOf,
  canvasOf,
  toContentTextBox,
};
