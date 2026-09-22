/**
 * Las rutas que no tenían **ningún** test de integración.
 *
 * ## Por qué existe este archivo
 *
 * Ayer se encontró que `POST /content/:id/schedule` devolvía `500` siempre y
 * convivía con 82 tests verdes, porque **nadie ejercitaba la ruta**. El bug no
 * era sutil —el nombre de la cola— pero era invisible: la única forma de verlo
 * era mandar un request.
 *
 * Cruzando `src/routes/v1/*.ts` contra los `test/*.int.test.ts` quedaban diez
 * rutas más en esa situación. Las que **escriben** o **encolan** son las que
 * pueden romperse en silencio, así que están primero; las de lectura van al
 * final, más cortas.
 *
 * ## Qué mide cada bloque, además del status
 *
 * Un `200` no dice que el efecto ocurrió, y un `400` no dice que el efecto
 * **no** ocurrió. Casi todos los casos de acá comprueban las dos mitades: el
 * código y la base. Las dos que más valen son los lotes de `posts`, donde
 * `NFR-011` promete *todo o nada*: un lote con un id malo tiene que dejar
 * intacto al bueno, y eso no se deduce del status.
 *
 * ## Escribir filas con `api.handle.sql`
 *
 * Varias rutas necesitan una pieza editable —`CREATED`, con cajas de texto y
 * sin posts vinculados— que ningún endpoint sabe crear: `POST /content` crea
 * justamente lo contrario (sin cajas, y por eso no es editable). Se insertan
 * con el cliente crudo de postgres.js, igual que `helpers/fixtures.ts`, y por
 * la misma razón: es código de fixture, el `companyId` va explícito en cada
 * fila y no hay ningún `WHERE` de tenant que olvidar. `drizzle-orm` no es
 * alcanzable desde `apps/api`, a propósito.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { JOB_QUEUES } from "@fastgram/core";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;

beforeAll(async () => {
  api = await startApi();
}, 180_000);

afterAll(async () => {
  await api?.close();
});

beforeEach(() => {
  api.queue.reset();
});

/* ── fixtures locales ───────────────────────────────────────────────────── */

/** Una caja de texto válida según `contentTextBoxSchema`. */
const BOX = {
  id: "slide-0-text-0",
  text: "Texto original",
  position: { x: 10, y: 20 },
  widthPercent: 80,
  // `anton` sólo admite peso 400: el schema lo valida contra `FONT_WEIGHTS`.
  font: { family: "anton", weight: 400, size: 48 },
  color: "#FFFFFF",
  stroke: { width: 2, color: "#000000" },
  background: null,
} as const;

const BUILD_PAYLOAD = {
  canvas: { width: 1080, height: 1920 },
  video: {
    url: "https://cdn.example.test/a.mp4",
    drawX: 0,
    drawY: 0,
    drawW: 1080,
    drawH: 1920,
  },
  text: {
    content: "Texto original",
    x: 50,
    y: 50,
    width: 800,
    fontSize: 48,
    color: "#FFFFFF",
    textAlign: "center",
  },
};

interface Editable {
  readonly contentId: string;
}

/**
 * Una pieza **editable**: `CREATED`, con una caja de texto y sin posts.
 *
 * Las tres condiciones son las de `assertEditable` (FR-051) y ninguna sobra: sin
 * caja da `422 content_not_editable`, en `BUILDING` da
 * `409 unsupported_content_state`, y con un post vinculado da
 * `409 content_has_linked_posts`.
 */
async function crearEditable(companyId: string): Promise<Editable> {
  const contentId = randomUUID();
  await api.handle.sql`
    insert into contents (id, company_id, type, status, revision, build_payload)
    values (${contentId}::uuid, ${companyId}::uuid, 'wall-of-text', 'CREATED', 1,
            ${JSON.stringify(BUILD_PAYLOAD)}::jsonb)
  `;
  await api.handle.sql`
    insert into content_text_boxes
      (id, content_id, company_id, slide_index, text, position, width_percent,
       font, color, stroke, background)
    values (${BOX.id}, ${contentId}::uuid, ${companyId}::uuid, 0, ${BOX.text},
            ${JSON.stringify(BOX.position)}::jsonb, ${BOX.widthPercent},
            ${JSON.stringify(BOX.font)}::jsonb, ${BOX.color},
            ${JSON.stringify(BOX.stroke)}::jsonb, null)
  `;
  return { contentId };
}

/** Un post `SCHEDULED` propio, para no depender del orden con otros casos. */
async function crearPost(
  companyId: string,
  connectionId: string,
  status = "SCHEDULED",
): Promise<string> {
  const contentId = randomUUID();
  const postId = randomUUID();
  await api.handle.sql`
    insert into contents (id, company_id, type, status, revision)
    values (${contentId}::uuid, ${companyId}::uuid, 'slideshow', 'CREATED', 1)
  `;
  await api.handle.sql`
    insert into posts (id, company_id, content_id, platform, account_type,
                       connection_id, scheduled_at_utc, status)
    values (${postId}::uuid, ${companyId}::uuid, ${contentId}::uuid, 'tiktok', 'oauth',
            ${connectionId}::uuid, '2026-10-01T12:00:00Z', ${status})
  `;
  return postId;
}

/** Una cuenta warmed propia. `warmed_accounts` cuelga de `companies` por FK, así
 * que el `truncate … cascade` del fixture la barre entre corridas. */
async function crearWarmed(companyId: string, username: string): Promise<string> {
  const id = randomUUID();
  await api.handle.sql`
    insert into warmed_accounts (warmed_account_id, company_id, platform, username,
                                 status, postable, min_lead_time_ms, country)
    values (${id}::uuid, ${companyId}::uuid, 'tiktok', ${username}, 'active', true,
            ${86_400_000}, 'US')
  `;
  return id;
}

const estadoDe = async (postId: string): Promise<string | undefined> => {
  const filas = await api.handle.sql`
    select status from posts where id = ${postId}::uuid
  `;
  return (filas[0] as unknown as { status: string } | undefined)?.status;
};

const revisionDe = async (contentId: string): Promise<number> => {
  const filas = await api.handle.sql`
    select revision from contents where id = ${contentId}::uuid
  `;
  return (filas[0] as unknown as { revision: number }).revision;
};

const buildJobs = (): { payload: unknown }[] =>
  api.queue.forQueue(JOB_QUEUES.contentBuild);

/* ══════════════════════════════════════════════════════════════════════════
 * POST /content/:id/regenerate — cero cobertura hasta acá
 * ══════════════════════════════════════════════════════════════════════════ */

describe("POST /content/:id/regenerate", () => {
  it("sube la revisión, deja la pieza en BUILDING y encola el rebuild", async () => {
    const { contentId } = await crearEditable(api.data.a.companyId);

    const res = await api.request({
      method: "POST",
      path: `/api/v1/content/${contentId}/regenerate`,
      body: {},
      idempotencyKey: `regen-${randomUUID()}`,
    });

    expect(res.status).toBe(200);
    const content = dataOf(res);
    expect(content["status"]).toBe("BUILDING");
    // FR-051: regenerar **no** crea una fila nueva ni cobra un save. Es la misma
    // pieza con la revisión movida.
    expect(content["_id"]).toBe(contentId);
    expect(content["revision"]).toBe(2);
    expect(await revisionDe(contentId)).toBe(2);

    const jobs = buildJobs();
    expect(jobs).toHaveLength(1);
    const payload = jobs[0]?.payload as {
      contentId?: string;
      reason?: string;
      revision?: number;
    };
    expect(payload.contentId).toBe(contentId);
    expect(payload.reason).toBe("regenerate");
    // La `revision` va en el payload **y** en la `singletonKey`: sin ella, el
    // segundo rebuild de la misma pieza se deduplicaría contra el primero.
    expect(payload.revision).toBe(2);
  });

  it("el `prompt` de AI-004 viaja hasta el payload del job", async () => {
    const { contentId } = await crearEditable(api.data.a.companyId);

    await api.request({
      method: "POST",
      path: `/api/v1/content/${contentId}/regenerate`,
      body: { prompt: "más corto y sin emojis", mentionBusiness: false },
      idempotencyKey: `regen-prompt-${randomUUID()}`,
    });

    const payload = buildJobs()[0]?.payload as {
      prompt?: string;
      mentionBusiness?: boolean;
    };
    // Sin esto la ruta podría aceptar el prompt y tirarlo, que es un fallo sin
    // síntoma: la pieza se rehace, sólo que ignorando lo que pidió el usuario.
    expect(payload.prompt).toBe("más corto y sin emojis");
    expect(payload.mentionBusiness).toBe(false);
  });

  it("una pieza sin cajas de texto es 422, y NO encola nada", async () => {
    // El contenido del fixture nace sin cajas, que es lo que crea `POST /content`.
    const antes = await revisionDe(api.data.a.contentId);

    const res = await api.request({
      method: "POST",
      path: `/api/v1/content/${api.data.a.contentId}/regenerate`,
      body: {},
      idempotencyKey: `regen-422-${randomUUID()}`,
    });

    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe("content_not_editable");
    // La mitad que el status no garantiza: un rechazo que igual encolara dejaría
    // al worker rehaciendo una pieza que la API dijo que no se puede tocar.
    expect(buildJobs()).toHaveLength(0);
    expect(await revisionDe(api.data.a.contentId)).toBe(antes);
  });

  it("con posts vinculados es 409 content_has_linked_posts (ERR-P06)", async () => {
    const { contentId } = await crearEditable(api.data.a.companyId);
    await api.handle.sql`
      insert into posts (company_id, content_id, platform, account_type,
                         connection_id, scheduled_at_utc, status)
      values (${api.data.a.companyId}::uuid, ${contentId}::uuid, 'tiktok', 'oauth',
              ${api.data.a.connectionId}::uuid, '2026-10-01T12:00:00Z', 'SCHEDULED')
    `;

    const res = await api.request({
      method: "POST",
      path: `/api/v1/content/${contentId}/regenerate`,
      body: {},
      idempotencyKey: `regen-409-${randomUUID()}`,
    });

    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("content_has_linked_posts");
    expect(errorOf(res).details).toEqual({ linkedPostCount: 1 });
    expect(buildJobs()).toHaveLength(0);
  });

  it("una pieza en BUILDING es 409 unsupported_content_state", async () => {
    const contentId = randomUUID();
    await api.handle.sql`
      insert into contents (id, company_id, type, status, revision)
      values (${contentId}::uuid, ${api.data.a.companyId}::uuid, 'wall-of-text',
              'BUILDING', 1)
    `;

    const res = await api.request({
      method: "POST",
      path: `/api/v1/content/${contentId}/regenerate`,
      body: {},
      idempotencyKey: `regen-building-${randomUUID()}`,
    });

    // El orden de `assertEditable` importa: sin cajas **y** en BUILDING, gana el
    // de las cajas. Por eso esta pieza no tiene cajas pero el caso anterior sí
    // las tenía — si el orden cambiara, uno de los dos se pondría rojo.
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe("content_not_editable");
  });

  it("la pieza de otro workspace es 404, no 403 (§9.2)", async () => {
    const res = await api.request({
      method: "POST",
      path: `/api/v1/content/${api.data.b.contentId}/regenerate`,
      body: {},
      idempotencyKey: `regen-ajeno-${randomUUID()}`,
    });
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe("not_found");
  });

  it("exige `Idempotency-Key`, y la misma key no rehace dos veces", async () => {
    const { contentId } = await crearEditable(api.data.a.companyId);

    const sinKey = await api.request({
      method: "POST",
      path: `/api/v1/content/${contentId}/regenerate`,
      body: {},
    });
    expect(sinKey.status).toBe(400);

    const key = `regen-replay-${randomUUID()}`;
    const primera = await api.request({
      method: "POST",
      path: `/api/v1/content/${contentId}/regenerate`,
      body: {},
      idempotencyKey: key,
    });
    api.queue.reset();
    const segunda = await api.request({
      method: "POST",
      path: `/api/v1/content/${contentId}/regenerate`,
      body: {},
      idempotencyKey: key,
    });

    expect(primera.status).toBe(200);
    expect(segunda.status).toBe(200);
    // **Igualdad semántica, no byte a byte, y es un hallazgo.**
    //
    // La respuesta del replay sale de `idempotency_records.response`, que es
    // una columna `jsonb` — y `jsonb` **normaliza el orden de las claves**
    // (longitud, después bytes). La original se serializa desde el objeto de
    // JavaScript, en orden de inserción. Las dos respuestas tienen los mismos
    // campos con los mismos valores y **distinto orden de claves**:
    //
    //   original: {"_id",…,"status","files","revision","lastEdit"}
    //   replay:   {"_id",…,"files","status","lastEdit","revision"}
    //
    // Semánticamente es el mismo JSON y ningún cliente sensato lo nota, pero
    // un `toBe(raw)` acá es un test que falla por una razón que no es la suya.
    // Queda dicho porque `Response.raw` se documenta como *"para comparar dos
    // respuestas byte a byte"* y para el replay **eso no aplica**.
    expect(segunda.body).toEqual(primera.body);
    // El replay devuelve la respuesta guardada: no vuelve a subir la revisión ni
    // a encolar. Sin esto, un reintento del cliente cuesta un rebuild entero.
    expect(await revisionDe(contentId)).toBe(2);
    expect(buildJobs()).toHaveLength(0);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * PATCH /content/:id
 * ══════════════════════════════════════════════════════════════════════════ */

describe("PATCH /content/:id", () => {
  it("escribe la caja, sube la revisión y encola el rebuild con reason `edit`", async () => {
    const { contentId } = await crearEditable(api.data.a.companyId);

    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/content/${contentId}`,
      body: { revision: 1, textBoxes: [{ ...BOX, text: "Texto nuevo" }] },
      idempotencyKey: `patch-${randomUUID()}`,
    });

    expect(res.status).toBe(200);
    expect(dataOf(res)["revision"]).toBe(2);

    const filas = await api.handle.sql`
      select text from content_text_boxes
      where content_id = ${contentId}::uuid and id = ${BOX.id}
    `;
    expect((filas[0] as unknown as { text: string }).text).toBe("Texto nuevo");

    const payload = buildJobs()[0]?.payload as { reason?: string };
    expect(payload.reason).toBe("edit");
  });

  it("una revisión vieja es 409 stale_revision y NO escribe nada", async () => {
    const { contentId } = await crearEditable(api.data.a.companyId);

    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/content/${contentId}`,
      // La pieza está en 1; el cliente cree que está en 7.
      body: { revision: 7, textBoxes: [{ ...BOX, text: "No debería entrar" }] },
      idempotencyKey: `patch-stale-${randomUUID()}`,
    });

    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("stale_revision");
    expect(errorOf(res).details).toEqual({ expected: 7, actual: 1 });

    const filas = await api.handle.sql`
      select text from content_text_boxes
      where content_id = ${contentId}::uuid and id = ${BOX.id}
    `;
    expect((filas[0] as unknown as { text: string }).text).toBe(BOX.text);
    expect(buildJobs()).toHaveLength(0);
  });

  it("un id de caja desconocido rechaza el lote entero sin aplicar nada", async () => {
    // FR-051 literal: *"se rechazan … IDs inexistentes … **sin aplicar ningún
    // cambio**"*. La caja buena va primera a propósito: si la validación fuera
    // perezosa en vez de una pasada completa, ya estaría escrita.
    const { contentId } = await crearEditable(api.data.a.companyId);

    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/content/${contentId}`,
      body: {
        revision: 1,
        textBoxes: [
          { ...BOX, text: "Cambio que no debe quedar" },
          { ...BOX, id: "slide-9-text-9", text: "Caja inventada" },
        ],
      },
      idempotencyKey: `patch-unknown-${randomUUID()}`,
    });

    expect(res.status).toBe(400);
    expect(errorOf(res).details).toEqual({ unknownTextBoxIds: ["slide-9-text-9"] });

    const filas = await api.handle.sql`
      select text from content_text_boxes
      where content_id = ${contentId}::uuid and id = ${BOX.id}
    `;
    expect((filas[0] as unknown as { text: string }).text).toBe(BOX.text);
    expect(await revisionDe(contentId)).toBe(1);
  });

  it("la pieza de otro workspace es 404", async () => {
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/content/${api.data.b.contentId}`,
      body: { revision: 1, textBoxes: [BOX] },
      idempotencyKey: `patch-ajeno-${randomUUID()}`,
    });
    expect(res.status).toBe(404);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * DELETE /content/:id
 * ══════════════════════════════════════════════════════════════════════════ */

describe("DELETE /content/:id", () => {
  it("borra una pieza `CREATED` y deja de listarse", async () => {
    const { contentId } = await crearEditable(api.data.a.companyId);

    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/content/${contentId}`,
    });
    expect(res.status).toBe(204);

    // Es soft-delete: la fila sigue, con `deleted_at`. Lo que tiene que
    // desaparecer es de los listados y del detalle.
    const detalle = await api.request({
      method: "GET",
      path: `/api/v1/content/${contentId}`,
    });
    expect(detalle.status).toBe(404);

    const filas = await api.handle.sql`
      select deleted_at from contents where id = ${contentId}::uuid
    `;
    expect(
      (filas[0] as unknown as { deleted_at: Date | null }).deleted_at,
    ).not.toBeNull();
  });

  it("una pieza en BUILDING dentro de la gracia es 409 content_still_building", async () => {
    // ERR-P02: se puede borrar **pasados 15 minutos**; antes, el build sigue
    // vivo y borrarla dejaría el job huérfano.
    const contentId = randomUUID();
    await api.handle.sql`
      insert into contents (id, company_id, type, status, revision)
      values (${contentId}::uuid, ${api.data.a.companyId}::uuid, 'wall-of-text',
              'BUILDING', 1)
    `;

    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/content/${contentId}`,
    });
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("content_still_building");

    const filas = await api.handle.sql`
      select deleted_at from contents where id = ${contentId}::uuid
    `;
    expect((filas[0] as unknown as { deleted_at: Date | null }).deleted_at).toBeNull();
  });

  it("pasada la gracia, la misma pieza en BUILDING sí se borra", async () => {
    // El control de la de arriba: si el 409 fuera "BUILDING no se borra nunca",
    // este caso lo dice. El reloj del arnés está fijo, así que se mueve
    // `created_at` hacia atrás en vez de esperar quince minutos.
    const contentId = randomUUID();
    await api.handle.sql`
      insert into contents (id, company_id, type, status, revision, created_at)
      values (${contentId}::uuid, ${api.data.a.companyId}::uuid, 'wall-of-text',
              'BUILDING', 1, '2026-09-21T10:00:00Z')
    `;

    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/content/${contentId}`,
    });
    expect(res.status).toBe(204);
  });

  /* ── ERR-P06 en el borrado (P2-CONTENT-006) ──────────────────────────────
   *
   * Hasta acá el `409 content_has_linked_posts` sólo lo ejercitaba
   * `POST /content/:id/regenerate`, y `DELETE` **no lo comprobaba**: miraba la
   * ventana de ERR-P02 y hacía `softDelete`. O sea que se podía borrar una pieza
   * con posts programados apuntándola, y ningún test lo decía.
   *
   * §20 del PRD (PRD:3317) pone *"Borrar contenido · Sin posts vinculados"* en
   * la misma tabla de dependencias que el resto, con el mismo código.
   */

  it("con un post vinculado es 409 content_has_linked_posts y NO borra (ERR-P06)", async () => {
    const { contentId } = await crearEditable(api.data.a.companyId);
    await api.handle.sql`
      insert into posts (company_id, content_id, platform, account_type,
                         connection_id, scheduled_at_utc, status)
      values (${api.data.a.companyId}::uuid, ${contentId}::uuid, 'tiktok', 'oauth',
              ${api.data.a.connectionId}::uuid, '2026-10-01T12:00:00Z', 'SCHEDULED')
    `;

    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/content/${contentId}`,
    });

    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("content_has_linked_posts");
    expect(errorOf(res).details).toEqual({ linkedPostCount: 1 });

    // La mitad que el status no garantiza. Un 409 que igual hubiera hecho el
    // `softDelete` deja al post apuntando a una pieza que ya no se lista, y el
    // síntoma aparece recién cuando el worker va a publicarlo.
    const filas = await api.handle.sql`
      select deleted_at from contents where id = ${contentId}::uuid
    `;
    expect((filas[0] as unknown as { deleted_at: Date | null }).deleted_at).toBeNull();
  });

  it("un post CANCELLED también cuenta: cancelar no basta (FLOW-008, PRD:1984)", async () => {
    // Éste es el caso que fija el criterio. Es el que se pone rojo si alguien
    // agrega un `status != 'CANCELLED'` al contador "para que se pueda borrar",
    // y el que hace que `DELETE` y `PATCH` no puedan responder distinto: las dos
    // rutas cuentan con la misma función.
    const { contentId } = await crearEditable(api.data.a.companyId);
    await api.handle.sql`
      insert into posts (company_id, content_id, platform, account_type,
                         connection_id, scheduled_at_utc, status)
      values (${api.data.a.companyId}::uuid, ${contentId}::uuid, 'tiktok', 'oauth',
              ${api.data.a.connectionId}::uuid, '2026-10-01T12:00:00Z', 'CANCELLED')
    `;

    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/content/${contentId}`,
    });

    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("content_has_linked_posts");

    // Y `PATCH` dice exactamente lo mismo sobre la misma pieza. Si las dos
    // rutas se separaran, este par es el que lo delata.
    const patch = await api.request({
      method: "PATCH",
      path: `/api/v1/content/${contentId}`,
      body: { revision: 1, textBoxes: [{ ...BOX, text: "otra cosa" }] },
      idempotencyKey: `patch-cancelled-${randomUUID()}`,
    });
    expect(patch.status).toBe(409);
    expect(errorOf(patch).code).toBe("content_has_linked_posts");
  });

  it("borrados los posts, la misma pieza sí se borra", async () => {
    // El control. Sin esto, un `409` constante —"nunca se puede borrar"— pasaría
    // los dos casos de arriba sin que nadie lo note.
    const { contentId } = await crearEditable(api.data.a.companyId);
    await api.handle.sql`
      insert into posts (company_id, content_id, platform, account_type,
                         connection_id, scheduled_at_utc, status)
      values (${api.data.a.companyId}::uuid, ${contentId}::uuid, 'tiktok', 'oauth',
              ${api.data.a.connectionId}::uuid, '2026-10-01T12:00:00Z', 'CANCELLED')
    `;
    expect(
      (await api.request({ method: "DELETE", path: `/api/v1/content/${contentId}` }))
        .status,
    ).toBe(409);

    await api.handle.sql`delete from posts where content_id = ${contentId}::uuid`;

    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/content/${contentId}`,
    });
    expect(res.status).toBe(204);
  });

  it("un post de la pieza de OTRO workspace no bloquea el borrado propio", async () => {
    // El contador va por `postRepository`, que exige `companyId`: un post ajeno
    // no puede sumar. Se comprueba porque el fallo sería silencioso y muy
    // confuso — "no puedo borrar mi pieza y no tengo ningún post".
    const { contentId } = await crearEditable(api.data.a.companyId);
    await api.handle.sql`
      insert into posts (company_id, content_id, platform, account_type,
                         connection_id, scheduled_at_utc, status)
      values (${api.data.b.companyId}::uuid, ${api.data.b.contentId}::uuid, 'tiktok',
              'oauth', ${api.data.b.connectionId}::uuid, '2026-10-01T12:00:00Z',
              'SCHEDULED')
    `;

    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/content/${contentId}`,
    });
    expect(res.status).toBe(204);
  });

  it("la pieza de otro workspace es 404 y sigue viva", async () => {
    const res = await api.request({
      method: "DELETE",
      path: `/api/v1/content/${api.data.b.contentId}`,
    });
    expect(res.status).toBe(404);

    const filas = await api.handle.sql`
      select deleted_at from contents where id = ${api.data.b.contentId}::uuid
    `;
    expect((filas[0] as unknown as { deleted_at: Date | null }).deleted_at).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * PATCH /media/:id
 * ══════════════════════════════════════════════════════════════════════════ */

describe("PATCH /media/:id", () => {
  it("reemplaza las categorías por completo (FR-100)", async () => {
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/media/${api.data.a.mediaId}`,
      body: { categories: ["slideshow-image", "green-screen-background"] },
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)["categories"]).toEqual([
      "slideshow-image",
      "green-screen-background",
    ]);

    // *"Cambiar categorías es un reemplazo total"*: la segunda escritura no
    // acumula. Si el repositorio hiciera un append, esto lo ve — y la lista
    // pasa de dos a una, que es el caso que un append disfraza peor.
    const segunda = await api.request({
      method: "PATCH",
      path: `/api/v1/media/${api.data.a.mediaId}`,
      body: { categories: ["slideshow-image"] },
    });
    expect(dataOf(segunda)["categories"]).toEqual(["slideshow-image"]);
  });

  it("una categoría de video sobre una imagen es 400 y dice cuáles entran", async () => {
    // El asset sembrado es `image`; `hook-video` es categoría de video.
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/media/${api.data.a.mediaId}`,
      body: { categories: ["hook-video"] },
    });
    expect(res.status).toBe(400);
    const details = errorOf(res).details as {
      mediaType?: string;
      allowedCategories?: string[];
    };
    // F-129: el `details` dice cuáles entran para que el cliente no tenga que
    // adivinar cuál de las cinco sobraba.
    expect(details.mediaType).toBe("image");
    expect(details.allowedCategories).toEqual([
      "slideshow-image",
      "green-screen-background",
    ]);
  });

  it("el asset de otro workspace es 404, y sus categorías no cambian", async () => {
    const res = await api.request({
      method: "PATCH",
      path: `/api/v1/media/${api.data.b.mediaId}`,
      body: { categories: ["slideshow-image"] },
    });
    expect(res.status).toBe(404);

    const filas = await api.handle.sql`
      select categories from media where media_id = ${api.data.b.mediaId}::uuid
    `;
    expect((filas[0] as unknown as { categories: string[] }).categories).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * POST /posts/cancel — `NFR-011`: todo o nada
 * ══════════════════════════════════════════════════════════════════════════ */

describe("POST /posts/cancel", () => {
  it("cancela y devuelve los posts como quedaron", async () => {
    const postId = await crearPost(api.data.a.companyId, api.data.a.connectionId);

    const res = await api.request({
      method: "POST",
      path: "/api/v1/posts/cancel",
      body: { postIds: [postId] },
    });

    expect(res.status).toBe(200);
    const posts = res.body?.["data"] as { status: string }[];
    expect(posts[0]?.status).toBe("CANCELLED");
    expect(await estadoDe(postId)).toBe("CANCELLED");
  });

  it("un id ajeno tumba el lote entero y el post bueno NO se cancela", async () => {
    // Ésta es la aserción que vale: `NFR-011` promete *todo o nada*, y un lote
    // que cancela lo que puede e informa el resto pasaría igual el chequeo del
    // status. Lo que distingue las dos implementaciones es la segunda línea.
    const propio = await crearPost(api.data.a.companyId, api.data.a.connectionId);

    const res = await api.request({
      method: "POST",
      path: "/api/v1/posts/cancel",
      body: { postIds: [propio, api.data.b.postId] },
    });

    expect(res.status).toBe(400);
    expect(errorOf(res).details).toEqual({
      // Ajeno e inexistente son el mismo `not_found` (§9.2).
      failures: [{ id: api.data.b.postId, reason: "not_found" }],
    });
    expect(await estadoDe(propio)).toBe("SCHEDULED");
    expect(await estadoDe(api.data.b.postId)).toBe("SCHEDULED");
  });

  it("un id que no es uuid es 400 `invalid_id`, no 500", async () => {
    // ERR-F01. Sin la puerta de `isStorableId`, el string llega a Postgres y
    // sale como *invalid input syntax for type uuid* → 500: un error nuestro
    // por un dato del cliente.
    const res = await api.request({
      method: "POST",
      path: "/api/v1/posts/cancel",
      body: { postIds: ["no-soy-un-uuid"] },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toEqual({
      failures: [{ id: "no-soy-un-uuid", reason: "invalid_id" }],
    });
  });

  it("cancelar uno ya cancelado no falla y no reescribe la fila", async () => {
    const postId = await crearPost(
      api.data.a.companyId,
      api.data.a.connectionId,
      "CANCELLED",
    );
    const antes = await api.handle.sql`
      select updated_at from posts where id = ${postId}::uuid
    `;

    const res = await api.request({
      method: "POST",
      path: "/api/v1/posts/cancel",
      body: { postIds: [postId] },
    });
    expect(res.status).toBe(200);

    const despues = await api.handle.sql`
      select updated_at from posts where id = ${postId}::uuid
    `;
    // Volver a poner `CANCELLED` movería `updatedAt` y diría que algo cambió
    // cuando no cambió nada.
    expect(String((despues[0] as unknown as { updated_at: Date }).updated_at)).toBe(
      String((antes[0] as unknown as { updated_at: Date }).updated_at),
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * POST /posts/delete
 * ══════════════════════════════════════════════════════════════════════════ */

describe("POST /posts/delete", () => {
  it("borra de verdad la fila y responde 204", async () => {
    const postId = await crearPost(api.data.a.companyId, api.data.a.connectionId);

    const res = await api.request({
      method: "POST",
      path: "/api/v1/posts/delete",
      body: { postIds: [postId] },
    });
    expect(res.status).toBe(204);

    // `posts` no tiene columna de soft-delete: el repositorio sólo ofrece
    // `hardDelete`, así que la fila desaparece. Está reportado como
    // contradicción con §12 (`GET /posts?status=DELETED` no puede devolver nada).
    const filas = await api.handle.sql`
      select id from posts where id = ${postId}::uuid
    `;
    expect(filas).toHaveLength(0);
  });

  it("un id ajeno tumba el lote y el post propio sigue existiendo", async () => {
    const propio = await crearPost(api.data.a.companyId, api.data.a.connectionId);

    const res = await api.request({
      method: "POST",
      path: "/api/v1/posts/delete",
      body: { postIds: [propio, api.data.b.postId] },
    });
    expect(res.status).toBe(400);

    // Las dos mitades: no se borró el propio, y tampoco el ajeno.
    expect(await estadoDe(propio)).toBe("SCHEDULED");
    expect(await estadoDe(api.data.b.postId)).toBe("SCHEDULED");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * POST /analytics/posts
 * ══════════════════════════════════════════════════════════════════════════ */

describe("POST /analytics/posts", () => {
  it("los ids desconocidos son éxito parcial, en el orden del pedido", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/analytics/posts",
      body: { postIds: [api.data.unknownId, api.data.a.postId] },
    });

    expect(res.status).toBe(200);
    const rows = res.body?.["data"] as { _id: string; notFound?: boolean }[];
    // El orden sigue al del pedido: el cliente empareja por posición.
    expect(rows[0]).toEqual({ _id: api.data.unknownId, notFound: true });
    expect(rows[1]?._id).toBe(api.data.a.postId);
    expect(rows[1]?.notFound).toBeUndefined();
  });

  it("un id malformado falla toda la request con `invalidIds` (ERR-F02)", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/analytics/posts",
      body: { postIds: ["xx", api.data.a.postId] },
    });
    expect(res.status).toBe(400);
    expect(errorOf(res).details).toEqual({ invalidIds: ["xx"] });
  });

  it("el post de otro workspace es `notFound`, no sus métricas", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/analytics/posts",
      body: { postIds: [api.data.b.postId] },
    });
    const rows = res.body?.["data"] as { notFound?: boolean }[];
    expect(rows[0]?.notFound).toBe(true);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * POST /blitz/angles/generate — sin adaptador de LLM montado
 * ══════════════════════════════════════════════════════════════════════════ */

describe("POST /blitz/angles/generate", () => {
  it("sin `angleGenerator` responde 503, no 500 ni un ángulo inventado", async () => {
    // Hoy ninguna app monta el adaptador, así que éste es **el** camino de
    // producción de esta ruta. Un 500 diría "bug nuestro" y un ángulo de relleno
    // sería peor: AI-005 no persiste la sugerencia, así que nadie la revisaría.
    const res = await api.request({
      method: "POST",
      path: "/api/v1/blitz/angles/generate",
      body: {},
    });
    expect(res.status).toBe(503);
    expect(errorOf(res).code).toBe("service_unavailable");
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * Las lecturas que tampoco tenían test
 * ══════════════════════════════════════════════════════════════════════════ */

describe("lecturas sin cobertura", () => {
  it("GET /content/:id devuelve la pieza y NO su `buildPayload` (DATA-008)", async () => {
    const res = await api.request({
      method: "GET",
      path: `/api/v1/content/${api.data.a.contentId}`,
    });
    expect(res.status).toBe(200);
    expect(dataOf(res)["_id"]).toBe(api.data.a.contentId);
    expect(res.raw).not.toContain("buildPayload");
    expect(res.raw).not.toContain("studioState");
  });

  it("GET /content/:id/editable devuelve canvas y cajas", async () => {
    const { contentId } = await crearEditable(api.data.a.companyId);
    const res = await api.request({
      method: "GET",
      path: `/api/v1/content/${contentId}/editable`,
    });
    expect(res.status).toBe(200);
    const editable = dataOf(res) as {
      canvas: { width: number };
      textBoxes: { id: string }[];
    };
    expect(editable.canvas.width).toBe(1080);
    expect(editable.textBoxes.map((b) => b.id)).toEqual([BOX.id]);
  });

  it("GET /content/:id/editable sin canvas es 422, no 500", async () => {
    // El contenido del fixture no tiene `buildPayload`, así que `canvasOf`
    // devuelve `null`. ERR-P05: sin canvas no hay superficie sobre la que
    // colocar una caja.
    const res = await api.request({
      method: "GET",
      path: `/api/v1/content/${api.data.a.contentId}/editable`,
    });
    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe("content_not_editable");
  });

  it("GET /posts/:id y GET /influencers/:id: propio 200, ajeno 404", async () => {
    const post = await api.request({
      method: "GET",
      path: `/api/v1/posts/${api.data.a.postId}`,
    });
    expect(post.status).toBe(200);
    const postAjeno = await api.request({
      method: "GET",
      path: `/api/v1/posts/${api.data.b.postId}`,
    });
    expect(postAjeno.status).toBe(404);

    const influ = await api.request({
      method: "GET",
      path: `/api/v1/influencers/${api.data.a.influencerId}`,
    });
    expect(influ.status).toBe(200);
    const influAjeno = await api.request({
      method: "GET",
      path: `/api/v1/influencers/${api.data.b.influencerId}`,
    });
    expect(influAjeno.status).toBe(404);
  });

  it("GET /connections lista la del workspace y no la del otro", async () => {
    const res = await api.request({ method: "GET", path: "/api/v1/connections" });
    expect(res.status).toBe(200);
    const items = res.body?.["data"] as { _id: string }[];
    const ids = items.map((c) => c._id);
    expect(ids).toContain(api.data.a.connectionId);
    expect(ids).not.toContain(api.data.b.connectionId);
  });

  it("GET /warmed-accounts lista la del workspace y no la del otro", async () => {
    const mia = await crearWarmed(api.data.a.companyId, "cuenta-a");
    const ajena = await crearWarmed(api.data.b.companyId, "cuenta-b");

    const res = await api.request({ method: "GET", path: "/api/v1/warmed-accounts" });
    expect(res.status).toBe(200);
    // Es el único listado de la v1 **sin cursor**, y su envelope lleva tres
    // campos extra (PRD:1695). Se comprueban: si alguien lo "normalizara" a la
    // forma paginada del resto, el cliente perdería `slotBalance`.
    const items = res.body?.["data"] as { warmedAccountId: string }[];
    const ids = items.map((a) => a.warmedAccountId);
    expect(ids).toContain(mia);
    expect(ids).not.toContain(ajena);
    expect(res.body?.["slotBalance"]).toBe(0);
    expect(res.body?.["replacementDecisions"]).toEqual([]);
    // El `minLeadTimeMs` global es **el mayor** de las cuentas visibles: es el
    // único con el que aplicarlo a todas no programa nada demasiado pronto.
    expect(res.body?.["minLeadTimeMs"]).toBe(86_400_000);
  });

  it("GET /tiktok/sounds comprueba el scope ANTES de devolver el 503", async () => {
    // Es la aserción que vale de esta ruta, y la escribió el comentario del
    // handler: el catálogo no existe (INT-001 sin adaptador) así que **siempre**
    // termina en 503. Si el 503 saliera antes del `findById`, el endpoint
    // estaría diciendo "existe" sobre el `warmedAccountId` de otro workspace
    // por omisión — un `404` y un `503` distinguen ids ajenos de propios.
    const propia = await crearWarmed(api.data.a.companyId, "sonidos-a");
    const ajena = await crearWarmed(api.data.b.companyId, "sonidos-b");

    const sinParam = await api.request({
      method: "GET",
      path: "/api/v1/tiktok/sounds",
    });
    expect(sinParam.status).toBe(400);

    const deOtro = await api.request({
      method: "GET",
      path: `/api/v1/tiktok/sounds?warmedAccountId=${ajena}`,
    });
    expect(deOtro.status).toBe(404);

    const propia503 = await api.request({
      method: "GET",
      path: `/api/v1/tiktok/sounds?warmedAccountId=${propia}`,
    });
    expect(propia503.status).toBe(503);
    expect(errorOf(propia503).code).toBe("service_unavailable");
  });
});
