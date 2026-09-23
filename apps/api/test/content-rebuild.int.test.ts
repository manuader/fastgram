/**
 * El productor de `content-rebuild` — PRD §9.5.4, `FR-051`, `AI-004`.
 *
 * `PATCH /content/:id` y `POST /content/:id/regenerate` encolaban en
 * `content-build`, cuyo handler cierra un fallo con `FAILED` **y reembolso**:
 * una edición que fallaba devolvía el save del build original —que sí se
 * entregó— y mataba una pieza que el PRD dice que sigue usable (PRD:1204).
 *
 * Lo que este archivo fija, además de «encola en la cola correcta»:
 *
 *  - que el encolado va **en la misma transacción** que la revisión y las
 *    cajas: si la cola falla, nada de la edición queda escrito;
 *  - que dos ediciones sucesivas producen **dos jobs** con claves distintas
 *    (trampa 45: una clave repetida no encola nada y la pieza queda en
 *    `BUILDING` para siempre);
 *  - que si alguna vez la clave se repite, la API **no responde 200**;
 *  - que dos `PATCH` simultáneos con la misma `revision` no aceptan los dos:
 *    es lo que hace única a la `revision`, y con ella a la clave;
 *  - que ninguna de las dos rutas toca el ledger (PRD:1186).
 */
import { randomUUID } from "node:crypto";
import { JOB_QUEUES } from "@fastgram/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

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

const BOX = {
  id: "slide-0-text-0",
  text: "Texto original",
  position: { x: 10, y: 20 },
  widthPercent: 80,
  font: { family: "anton", weight: 400, size: 48 },
  color: "#FFFFFF",
  stroke: { width: 2, color: "#000000" },
  background: null,
} as const;

/** Una pieza editable: `CREATED`, con una caja, sin posts, y **con cargo**. */
async function editable(companyId: string): Promise<string> {
  const contentId = randomUUID();
  // `save_bucket`/`save_period` puestos a propósito: es el caso en que un
  // handler que reembolsa tendría algo que devolver.
  await api.handle.sql`
    insert into contents (id, company_id, type, status, revision, files,
                          save_bucket, save_period)
    values (${contentId}::uuid, ${companyId}::uuid, 'wall-of-text', 'CREATED', 1,
            ${["https://cdn.example.test/prev.mp4"]}::text[], 'included', '2026-09-01')
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
  return contentId;
}

async function fila(contentId: string) {
  const filas = await api.handle.sql`
    select c.status, c.revision, c.files, b.text
    from contents c
    join content_text_boxes b on b.content_id = c.id and b.id = ${BOX.id}
    where c.id = ${contentId}::uuid
  `;
  return filas[0] as unknown as {
    status: string;
    revision: number;
    files: string[];
    text: string;
  };
}

/** Lo que cobró el workspace, sumando todos sus períodos. */
async function savesUsados(companyId: string): Promise<number> {
  const filas = await api.handle.sql`
    select coalesce(sum(content_saves_used), 0)::int as n
    from quota_ledgers where company_id = ${companyId}::uuid
  `;
  return (filas[0] as unknown as { n: number }).n;
}

const patch = (contentId: string, revision: number, text: string) =>
  api.request({
    method: "PATCH",
    path: `/api/v1/content/${contentId}`,
    body: { revision, textBoxes: [{ ...BOX, text }] },
    idempotencyKey: `rebuild-${randomUUID()}`,
  });

const rebuilds = () => api.queue.forQueue(JOB_QUEUES.contentRebuild);

/** Lo que haría el handler al terminar: la pieza vuelve a `CREATED`. */
const terminarRebuild = (contentId: string) => api.handle.sql`
  update contents set status = 'CREATED' where id = ${contentId}::uuid
`;

describe("PATCH y regenerate encolan en content-rebuild", () => {
  it("PATCH: un job en content-rebuild, ninguno en content-build", async () => {
    const contentId = await editable(api.data.a.companyId);

    const res = await patch(contentId, 1, "Nuevo");

    expect(res.status).toBe(200);
    // Primero lo que NO tiene que pasar (trampa 35): un job en content-build
    // es el handler que reembolsa.
    expect(api.queue.forQueue(JOB_QUEUES.contentBuild)).toHaveLength(0);
    const jobs = rebuilds();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.payload).toMatchObject({
      companyId: api.data.a.companyId,
      contentId,
      contentType: "wall-of-text",
      revision: 2,
      reason: "edit",
    });
    expect(jobs[0]?.options?.singletonKey).toBe(
      `${JOB_QUEUES.contentRebuild}:${contentId}:2`,
    );
    // Dentro de la transacción de la ruta (ADR-005): sin `transaction`, el job
    // se confirmaría aunque la edición volviera atrás.
    expect(jobs[0]?.options?.transaction).toBeDefined();
  });

  it("regenerate: también content-rebuild, con reason `regenerate`", async () => {
    const contentId = await editable(api.data.a.companyId);

    const res = await api.request({
      method: "POST",
      path: `/api/v1/content/${contentId}/regenerate`,
      body: { prompt: "más corto" },
      idempotencyKey: `regen-${randomUUID()}`,
    });

    expect(res.status).toBe(200);
    expect(api.queue.forQueue(JOB_QUEUES.contentBuild)).toHaveLength(0);
    expect(rebuilds()[0]?.payload).toMatchObject({
      contentId,
      revision: 2,
      reason: "regenerate",
      prompt: "más corto",
    });
  });

  it("ninguna de las dos toca el ledger (PRD:1186)", async () => {
    const contentId = await editable(api.data.a.companyId);
    const antes = await savesUsados(api.data.a.companyId);

    expect((await patch(contentId, 1, "Uno")).status).toBe(200);
    await terminarRebuild(contentId);
    const regen = await api.request({
      method: "POST",
      path: `/api/v1/content/${contentId}/regenerate`,
      body: {},
      idempotencyKey: `regen-${randomUUID()}`,
    });
    expect(regen.status).toBe(200);

    expect(await savesUsados(api.data.a.companyId)).toBe(antes);
  });
});

describe("la clave no se repite entre ediciones — trampa 45", () => {
  it("dos ediciones sucesivas son dos jobs con claves distintas", async () => {
    const contentId = await editable(api.data.a.companyId);

    expect((await patch(contentId, 1, "Primera")).status).toBe(200);
    await terminarRebuild(contentId);
    expect((await patch(contentId, 2, "Segunda")).status).toBe(200);
    await terminarRebuild(contentId);
    const regen = await api.request({
      method: "POST",
      path: `/api/v1/content/${contentId}/regenerate`,
      body: {},
      idempotencyKey: `regen-${randomUUID()}`,
    });
    expect(regen.status).toBe(200);

    // `RecordingQueue` honra `singletonKey` como el adaptador real: si dos
    // claves fueran iguales, habría menos de tres jobs.
    const claves = rebuilds().map((j) => j.options?.singletonKey);
    expect(claves).toHaveLength(3);
    expect(new Set(claves).size).toBe(3);
    expect(rebuilds().map((j) => (j.payload as { revision: number }).revision)).toEqual([
      2, 3, 4,
    ]);
  });

  it("si la clave ya tenía job, NO responde 200 y la edición vuelve atrás", async () => {
    // Es la otra mitad de la trampa 45: quien encola y no mira `created` no se
    // entera de que no encoló, y la pieza queda en BUILDING sin nadie que la
    // construya. Se provoca ocupando a mano la clave que la ruta va a usar.
    const contentId = await editable(api.data.a.companyId);
    await api.queue.enqueue({
      queue: JOB_QUEUES.contentRebuild,
      payload: {},
      options: { singletonKey: `${JOB_QUEUES.contentRebuild}:${contentId}:2` },
    });

    const res = await patch(contentId, 1, "No debería quedar");

    expect(res.status).not.toBe(200);
    expect(res.status).toBe(500);
    const row = await fila(contentId);
    expect(row.status).toBe("CREATED");
    expect(row.revision).toBe(1);
    expect(row.text).toBe(BOX.text);
  });

  it("dos PATCH con la misma revisión: el segundo es 409, no una segunda revisión 2", async () => {
    // La `revision` sólo sirve de clave si cada edición aceptada tiene la suya.
    // Sin bloqueo, dos PATCH simultáneos leían los dos `revision = 1`, pasaban
    // la guarda y escribían los dos `2`.
    //
    // No se lanza con `Promise.all` (trampa 34: mediría el pool). Se **sostiene
    // una transacción a mano** con la fila bloqueada —como haría un PATCH en
    // vuelo— que sube la revisión a 2, y recién después se suelta.
    const contentId = await editable(api.data.a.companyId);

    let soltar!: () => void;
    const puerta = new Promise<void>((r) => {
      soltar = r;
    });
    let bloqueada!: () => void;
    const tomada = new Promise<void>((r) => {
      bloqueada = r;
    });

    const sostenida = api.handle.sql.begin(async (sql) => {
      await sql`select id from contents where id = ${contentId}::uuid for update`;
      bloqueada();
      await puerta;
      await sql`
        update contents set revision = 2, status = 'CREATED'
        where id = ${contentId}::uuid
      `;
    });
    await tomada;

    const enVuelo = patch(contentId, 1, "Llegó tarde");
    // Se le da tiempo de sobra a la ruta para leer si NO espera el lock.
    await new Promise((r) => setTimeout(r, 300));
    soltar();
    await sostenida;
    const res = await enVuelo;

    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("stale_revision");
    expect(rebuilds()).toHaveLength(0);
    expect((await fila(contentId)).text).toBe(BOX.text);
  });
});

describe("regenerate también bloquea la fila", () => {
  it("un regenerate que espera a una edición en vuelo ve BUILDING y no encola", async () => {
    // `regenerateContentRequestSchema` no lleva `revision`, así que acá no hay
    // `stale_revision` que salve: sin `FOR UPDATE`, el regenerate leía
    // `CREATED` con la revisión vieja, esperaba recién en el UPDATE y escribía
    // la misma revisión que la edición en vuelo — dos ediciones, una revisión.
    const contentId = await editable(api.data.a.companyId);

    let soltar!: () => void;
    const puerta = new Promise<void>((r) => {
      soltar = r;
    });
    let bloqueada!: () => void;
    const tomada = new Promise<void>((r) => {
      bloqueada = r;
    });
    const sostenida = api.handle.sql.begin(async (sql) => {
      await sql`select id from contents where id = ${contentId}::uuid for update`;
      bloqueada();
      await puerta;
      await sql`
        update contents set revision = 2, status = 'BUILDING'
        where id = ${contentId}::uuid
      `;
    });
    await tomada;

    const enVuelo = api.request({
      method: "POST",
      path: `/api/v1/content/${contentId}/regenerate`,
      body: {},
      idempotencyKey: `regen-${randomUUID()}`,
    });
    await new Promise((r) => setTimeout(r, 300));
    soltar();
    await sostenida;
    const res = await enVuelo;

    expect(rebuilds()).toHaveLength(0);
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("unsupported_content_state");
  });
});

describe("el encolado va en la misma transacción que la edición", () => {
  it("si la cola falla, ni la revisión ni la caja ni el BUILDING quedan escritos", async () => {
    const contentId = await editable(api.data.a.companyId);
    api.queue.failNext = true;

    const res = await patch(contentId, 1, "Tampoco debería quedar");

    expect(res.status).toBe(500);
    const row = await fila(contentId);
    expect(row.status).toBe("CREATED");
    expect(row.revision).toBe(1);
    expect(row.text).toBe(BOX.text);
    expect(row.files).toEqual(["https://cdn.example.test/prev.mp4"]);
  });

  it("la pieza de otro workspace es 404 y no encola nada", async () => {
    const ajena = await editable(api.data.b.companyId);

    const res = await patch(ajena, 1, "Cruzado");

    expect(res.status).toBe(404);
    expect(rebuilds()).toHaveLength(0);
    expect((await fila(ajena)).revision).toBe(1);
  });
});
