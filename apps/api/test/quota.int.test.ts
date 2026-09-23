/**
 * El cobro de content saves, extremo a extremo — `FR-050`, PRD §16.2.
 *
 * Hasta acá `POST /content` **no cobraba nada**. No por descuido: faltaban tres
 * piezas —de dónde sale el plan, qué clave identifica el período, y dónde se
 * guarda el bucket— y cablearlo a medias habría sido peor que no cablearlo,
 * porque cobraría un save que el camino de reembolso no sabría devolver.
 *
 * Lo que este archivo persigue no es "descuenta un número". Es lo que hace que
 * el reembolso sea posible después: que quede escrito **de qué bucket salió** y
 * **a qué período**, porque los tres buckets tienen precio distinto y devolver
 * al que no fue es un error de facturación que nadie ve.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  contentQuotaExceededDetailsSchema,
  errorEnvelopeSchema,
} from "@fastgram/contracts";
import { billingPeriodKey, nextBillingResetUtc, PLANS } from "@fastgram/core";

import { dataOf, startApi, type ApiHarness } from "./helpers/harness.js";

let api: ApiHarness;

const WALL_OF_TEXT = {
  canvas: { width: 1080, height: 1920 },
  video: {
    url: "https://cdn.example.test/a.mp4",
    drawX: 0,
    drawY: 0,
    drawW: 1080,
    drawH: 1920,
  },
  text: {
    content: "Cuota",
    x: 50,
    y: 50,
    width: 800,
    fontSize: 48,
    color: "#FFFFFF",
    textAlign: "center",
  },
};

let n = 0;
const crear = () =>
  api.request({
    method: "POST",
    path: "/api/v1/content",
    body: WALL_OF_TEXT,
    idempotencyKey: `cuota-${String((n += 1))}-${String(Date.now())}`,
  });

/** El ledger del período en curso, leído directo: el test mira la contabilidad. */
async function ledger(): Promise<{
  content_saves_used: number;
  content_saves_purchased: number;
  overage_units: number;
} | null> {
  const period = billingPeriodKey(new Date(api.clock.nowMs()), 1);
  // `handle.sql` es el cliente crudo de postgres.js, no Drizzle: `drizzle-orm`
  // **no es alcanzable desde `apps/api`**, y eso es a propósito — es lo que
  // impide que una ruta arme su propio `WHERE` y se olvide el tenant. Un test
  // que lee contabilidad directo es código de fixture, no de request.
  const filas = await api.handle.sql`
    select content_saves_used, content_saves_purchased, overage_units
    from quota_ledgers
    where company_id = ${api.data.a.companyId}::uuid and period = ${period}
  `;
  return (filas[0] as never) ?? null;
}

beforeAll(async () => {
  api = await startApi();
}, 180_000);

afterAll(async () => {
  await api?.close();
});

describe("POST /content cobra", () => {
  it("descuenta un save del cupo incluido", async () => {
    const antes = await ledger();
    const res = await crear();
    expect(res.status).toBe(201);

    const despues = await ledger();
    expect(despues?.content_saves_used).toBe((antes?.content_saves_used ?? 0) + 1);
  });

  it("deja escrito el bucket y el período en la pieza", async () => {
    // Sin estos dos campos el reembolso de `FR-050` es imposible: no se sabría
    // a qué bucket devolver ni a qué ledger. El CHECK de la base exige que
    // estén los dos o ninguno.
    const res = await crear();
    const contentId = dataOf(res)["_id"];

    const filas = await api.handle.sql`
      select save_bucket, save_period, save_refunded_at
      from contents where id = ${String(contentId)}::uuid
    `;
    const fila = filas[0] as unknown as {
      save_bucket: string;
      save_period: string;
      save_refunded_at: unknown;
    };
    expect(fila.save_bucket).toBe("included");
    expect(fila.save_period).toBe(billingPeriodKey(new Date(api.clock.nowMs()), 1));
    expect(fila.save_refunded_at).toBeNull();
  });

  it("el bucket y el período NO salen por la API", async () => {
    // Son contabilidad interna. El contrato de `Content` (§12) no los incluye,
    // y el tipo de retorno del serializador ya lo impide; esto lo comprueba
    // sobre el JSON real.
    const res = await crear();
    expect(res.raw).not.toContain("saveBucket");
    expect(res.raw).not.toContain("savePeriod");
  });

  it("el replay de idempotencia NO cobra dos veces", async () => {
    // Es la mitad de la idempotencia que importa para la factura: un cliente
    // que reintenta por timeout no puede pagar dos veces por una pieza.
    const key = `replay-cobro-${String(Date.now())}`;
    const primera = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: key,
    });
    const antes = await ledger();

    const segunda = await api.request({
      method: "POST",
      path: "/api/v1/content",
      body: WALL_OF_TEXT,
      idempotencyKey: key,
    });

    expect(dataOf(segunda)["_id"]).toBe(dataOf(primera)["_id"]);
    expect((await ledger())?.content_saves_used).toBe(antes?.content_saves_used);
  });

  it("un fallo al encolar NO deja el save cobrado", async () => {
    // El cobro y la creación van en la misma transacción justamente por esto.
    // Si el cobro se confirmara aparte, el cliente pagaría por una pieza que no
    // existe — y no habría a qué asociar el reembolso, porque el reembolso se
    // dispara desde el contenido.
    const antes = await ledger();
    api.queue.failNext = true;

    const res = await crear();
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect((await ledger())?.content_saves_used).toBe(antes?.content_saves_used);
  });
});

describe("cuando no queda cuota", () => {
  it("responde 429 content_quota_exceeded con count/limit/resetAt del contrato (ERR-R03)", async () => {
    // Se agota el cupo escribiendo el contador al tope en vez de haciendo 100
    // peticiones: lo que se prueba es la respuesta al agotarse, no la
    // aritmética —eso ya está en `core/quota/quota.test.ts`— y 100
    // requests harían el test lento y frágil.
    //
    // Hasta el 2026-09-23 esto era `402` con `resetAt` en ISO y sin
    // `count`/`limit`: §19.8 dice `429`, el contrato dice ms de epoch, y
    // `POST /blitz` ya respondía así para la misma cuota.
    const now = new Date(api.clock.nowMs());
    const period = billingPeriodKey(now, 1);
    const tope = PLANS.growth.contentSaves ?? 0;
    await api.handle.sql`
      update quota_ledgers
      set content_saves_used = ${tope}, content_saves_purchased = 0, overage_units = 0
      where company_id = ${api.data.a.companyId}::uuid and period = ${period}
    `;

    const res = await crear();
    expect(res.status).toBe(429);
    // La respuesta entera, contra el zod de `@fastgram/contracts`.
    const envelope = errorEnvelopeSchema.parse(res.body);
    expect(envelope.error.code).toBe("content_quota_exceeded");
    // Copy literal de ERR-R03.
    expect(envelope.error.message).toBe("Monthly content quota reached for your plan");
    // `.strict()`: lo que el contrato no nombra (`plan`) no sale.
    const details = contentQuotaExceededDetailsSchema
      .strict()
      .parse(envelope.error.details);
    expect(details).toEqual({
      count: tope,
      limit: tope,
      // `resetAt` no es decoración: es lo que la UI necesita para decir cuándo
      // vuelve el cupo. En ms, y el del ancla de facturación del workspace.
      resetAt: nextBillingResetUtc(now, 1).getTime(),
    });
    // Un 429 de cuota no es un rate limit: no hay `Retry-After` que esperar.
    expect(res.headers["retry-after"]).toBeUndefined();
  });

  it("y NO crea la pieza ni encola nada", async () => {
    api.queue.reset();
    const antes = await api.request({ method: "GET", path: "/api/v1/content" });
    const cuantas = (antes.body?.["data"] as unknown[]).length;

    const res = await crear();
    expect(res.status).toBe(429);

    const despues = await api.request({ method: "GET", path: "/api/v1/content" });
    expect((despues.body?.["data"] as unknown[]).length).toBe(cuantas);
    expect(api.queue.enqueued).toHaveLength(0);
  });

  it("con saldo comprado, el save sale de ahí y el bucket lo dice", async () => {
    // El orden del PRD es incluido → comprado → overage, y el bucket que se
    // persiste tiene que ser el real: si dijera `included` cuando salió del
    // saldo comprado, el reembolso devolvería un crédito que caduca por uno
    // que no caducaba.
    const period = billingPeriodKey(new Date(api.clock.nowMs()), 1);
    await api.handle.sql`
      update quota_ledgers set content_saves_purchased = 2
      where company_id = ${api.data.a.companyId}::uuid and period = ${period}
    `;

    const res = await crear();
    expect(res.status).toBe(201);

    const filas = await api.handle.sql`
      select save_bucket from contents where id = ${String(dataOf(res)["_id"])}::uuid
    `;
    expect((filas[0] as unknown as { save_bucket: string }).save_bucket).toBe(
      "purchased",
    );
    expect((await ledger())?.content_saves_purchased).toBe(1);
  });
});
