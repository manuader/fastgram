/**
 * `POST /media` como productor de `media-normalization` — §9.5 #7, `NFR-014`,
 * `FR-100`.
 *
 * `FR-100`: *«los videos quedan `processing` y se normalizan en background
 * hasta `ready` o `failed`»*. Hasta esta tarea la ruta dejaba el video en
 * `processing` y no encolaba nada: el estado era verdad, y era para siempre.
 *
 * Corre sobre `MemoryStorage` y no sobre MinIO a propósito: lo que se mide es
 * **qué pide encolar la ruta**, no el PUT firmado (eso lo cubre
 * `media-upload.int.test.ts`). El objeto se deja en el storage directo, con la
 * clave que la reserva guardó en la base, que es lo único que `head()` mira.
 */
import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import { JOB_QUEUES } from "@fastgram/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { dataOf, startApi, type ApiHarness } from "./helpers/harness.js";

const NOW = "2026-09-21T12:00:00.000Z";

let api: ApiHarness;
const storage = new MemoryStorage(new FixedClock(NOW));

beforeAll(async () => {
  api = await startApi({ storage, now: NOW });
}, 180_000);

afterAll(async () => {
  await api?.close();
});

beforeEach(() => {
  api.queue.reset();
});

/** Reserva, «sube» y finaliza. Devuelve la respuesta de la finalización. */
async function subir(
  filename: string,
  contentType: string,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> | undefined }> {
  const bytes = new TextEncoder().encode(`bytes de ${filename}`);
  const reserva = await api.request({
    method: "POST",
    path: "/api/v1/media/upload-url",
    body: { filename, contentType, sizeBytes: bytes.byteLength },
    ...(token === undefined ? {} : { token }),
  });
  expect(reserva.status).toBe(200);
  const uploadId = String(dataOf(reserva)["uploadId"]);

  const filas = await api.handle.sql`
    select storage_key from upload_reservations where upload_id = ${uploadId}::uuid
  `;
  const key = (filas[0] as unknown as { storage_key: string }).storage_key;
  await storage.put({ key, body: bytes, contentType });

  const res = await api.request({
    method: "POST",
    path: "/api/v1/media",
    body: { uploadId },
    ...(token === undefined ? {} : { token }),
  });
  return { status: res.status, body: res.body };
}

describe("POST /media encola la normalización de los videos", () => {
  it("un MOV nace `processing` y deja exactamente un job con su mediaId", async () => {
    const res = await subir("clip.mov", "video/quicktime");
    expect(res.status).toBe(201);
    const asset = (res.body?.["data"] ?? {}) as Record<string, unknown>;
    expect(asset["status"]).toBe("processing");

    const jobs = api.queue.forQueue(JOB_QUEUES.mediaNormalization);
    expect(jobs).toHaveLength(1);
    const job = jobs[0];
    expect(job?.payload).toEqual({
      companyId: api.data.a.companyId,
      mediaId: asset["mediaId"],
    });
    // Una clave fija por asset: una normalización por asset (ver la ruta).
    expect(job?.options?.singletonKey).toBe(
      `${JOB_QUEUES.mediaNormalization}:${String(asset["mediaId"])}`,
    );
    // Dentro de la transacción de la ruta (ADR-005).
    expect(job?.options?.transaction).toBeDefined();
    // 3 intentos totales = el `maxAttempts` del catálogo del worker.
    expect(job?.options?.retryLimit).toBe(2);
  });

  it("un MP4 también: faststart y HDR sólo se saben midiendo el archivo", async () => {
    const res = await subir("clip.mp4", "video/mp4");
    expect(res.status).toBe(201);
    expect(api.queue.forQueue(JOB_QUEUES.mediaNormalization)).toHaveLength(1);
  });

  it("una imagen NO encola: nace `ready`", async () => {
    // Negativa primero (trampa 35): la cola vacía es lo que se afirma.
    const res = await subir("foto.png", "image/png");
    expect(api.queue.forQueue(JOB_QUEUES.mediaNormalization)).toHaveLength(0);
    expect(res.status).toBe(201);
    expect(((res.body?.["data"] ?? {}) as Record<string, unknown>)["status"]).toBe(
      "ready",
    );
  });

  it("dos videos, dos jobs con claves distintas", async () => {
    await subir("uno.mp4", "video/mp4");
    await subir("dos.mp4", "video/mp4");
    const claves = api.queue
      .forQueue(JOB_QUEUES.mediaNormalization)
      .map((j) => j.options?.singletonKey);
    expect(claves).toHaveLength(2);
    expect(new Set(claves).size).toBe(2);
  });

  it("si la cola falla, no queda ni el asset ni la reserva consumida", async () => {
    const antes = await api.handle.sql`
      select count(*)::int as n from media where company_id = ${api.data.a.companyId}::uuid
    `;
    api.queue.failNext = true;
    const res = await subir("falla.mp4", "video/mp4");
    expect(res.status).toBe(500);

    const despues = await api.handle.sql`
      select count(*)::int as n from media where company_id = ${api.data.a.companyId}::uuid
    `;
    expect((despues[0] as unknown as { n: number }).n).toBe(
      (antes[0] as unknown as { n: number }).n,
    );
    const reservas = await api.handle.sql`
      select state from upload_reservations where filename = 'falla.mp4'
    `;
    expect((reservas[0] as unknown as { state: string }).state).toBe("reserved");
    expect(JSON.stringify(res.body)).not.toContain("la cola no responde");
  });
});
