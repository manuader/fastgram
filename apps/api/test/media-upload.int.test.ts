/**
 * §9.8 completo, contra MinIO: reserva → **PUT de verdad** → finalización.
 *
 * ## Por qué este archivo tiene que existir
 *
 * `P1-STORAGE-007` montó `S3Storage` en `main.ts`. Un adaptador montado y no
 * ejercitado no vale nada, y acá "ejercitar" tiene un significado preciso: el
 * paso 2 del procedimiento es un **PUT del cliente contra la URL firmada**, y
 * es exactamente el paso que ningún otro test del repo puede hacer.
 * `MemoryStorage` —que es lo que monta el arnés por defecto, y con razón—
 * devuelve `memory://bucket/...` y nunca recibe bytes; con él, `POST /media`
 * responde **`409` siempre**, que es el bug que esta tarea cierra. Un test que
 * corriera sobre memoria mediría el 409 y lo llamaría verde.
 *
 * Así que lo único que prueba algo es hacer el PUT con la URL que devolvió la
 * API y comprobar que la finalización encuentra el objeto.
 *
 * ## Se saltea, y lo dice en el nombre
 *
 * Mismo criterio que la suite de contrato de `packages/adapters`: sin las
 * variables de S3 o sin bucket, cada caso se saltea **con el motivo en el
 * nombre**. Las credenciales salen del entorno y no del código: son de
 * desarrollo, pero un secreto escrito en un archivo deja de ser de desarrollo
 * el día que alguien copia el archivo.
 *
 * ## Qué queda fuera
 *
 * R2. Las diferencias que sólo se ven contra R2 —`etag` con multipart, la
 * `region`, el `Content-Disposition`— siguen sin medirse, igual que en
 * `packages/adapters`. Y la URL que se **persiste** (`Media.r2Url`) apunta al
 * endpoint de firma: el último `describe` mide esa igualdad, que es cierta en
 * desarrollo y deja de serlo con un CDN delante.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { S3Storage, canonicalObjectUrl } from "@fastgram/adapters";
import { JOB_QUEUES } from "@fastgram/core";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

/* ── configuración: del entorno, o nada ─────────────────────────────────── */

const ENV_KEYS = [
  "S3_ENDPOINT",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_PUBLIC_URL",
] as const;

const missing = ENV_KEYS.filter((k) => (process.env[k] ?? "") === "");

const CONFIG =
  missing.length > 0
    ? null
    : {
        endpoint: process.env["S3_ENDPOINT"] as string,
        bucket: process.env["S3_BUCKET"] as string,
        region: process.env["S3_REGION"] ?? "auto",
        accessKeyId: process.env["S3_ACCESS_KEY_ID"] as string,
        secretAccessKey: process.env["S3_SECRET_ACCESS_KEY"] as string,
        publicUrl: process.env["S3_PUBLIC_URL"] as string,
        // MinIO lo **exige**: sin esto devuelve `NoSuchBucket`, que parece un
        // problema de permisos y no lo es. Es el mismo valor que el default de
        // `S3_FORCE_PATH_STYLE` en `src/env.ts`.
        forcePathStyle: true,
      };

function storageFrom(config: NonNullable<typeof CONFIG>): S3Storage {
  return new S3Storage({
    bucket: config.bucket,
    endpoint: config.endpoint,
    region: config.region,
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    forcePathStyle: config.forcePathStyle,
  });
}

/**
 * La sonda escribe un objeto en vez de mirar si el endpoint responde, y no es
 * por gusto: `head()` sobre un bucket inexistente devuelve `null` —`NoSuchBucket`
 * entra en la traducción de "no encontrado"— así que un bucket que falta se
 * vería exactamente igual que un bucket vacío, y la suite correría creyendo
 * que hay dónde escribir. Un `put` prueba las tres cosas a la vez: endpoint,
 * credenciales y bucket.
 *
 * No se usa `@aws-sdk/client-s3` directamente porque no es dependencia de
 * `apps/api` y agregarla es tocar un `package.json`.
 */
async function probe(): Promise<string | null> {
  if (CONFIG === null) {
    return `faltan variables de entorno: ${missing.join(", ")}`;
  }
  try {
    await storageFrom(CONFIG).put({
      key: `__probe__/api-int-${String(process.pid)}`,
      body: Uint8Array.from([0x6f, 0x6b]),
      contentType: "text/plain",
    });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const reason = await probe();
const suffix = reason === null ? "" : ` · SALTEADA — ${reason}`;
const itS3 = reason === null ? it : it.skip;

/* ── el arnés, con el storage real ──────────────────────────────────────── */

let api: ApiHarness;

beforeAll(async () => {
  api = await startApi(CONFIG === null ? {} : { storage: storageFrom(CONFIG) });
}, 180_000);

afterAll(async () => {
  await api?.close();
});

/** Un PNG de 1×1, entero. El tamaño declarado tiene que ser el real: entra en la firma. */
const PNG_1X1 = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48,
  0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00,
  0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0a, 0x49, 0x44, 0x41, 0x54, 0x78,
  0x9c, 0x63, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

interface Reservation {
  readonly uploadId: string;
  readonly uploadUrl: string;
  readonly method: string;
  readonly headers: Record<string, string>;
}

function asReservation(body: Record<string, unknown>): Reservation {
  return body as unknown as Reservation;
}

/**
 * El paso 2 de §9.8, tal cual lo haría el cliente: la URL y las cabeceras que
 * devolvió la API, sin agregar ni quitar nada. Con SigV4 una cabecera de más o
 * de menos invalida la firma, así que reproducirlas exactamente **es** la
 * prueba.
 */
async function putDirecto(
  reservation: Reservation,
  body: Uint8Array,
  overrides: Record<string, string> = {},
): Promise<number> {
  const res = await fetch(reservation.uploadUrl, {
    method: reservation.method,
    headers: { ...reservation.headers, ...overrides },
    body,
    signal: AbortSignal.timeout(20_000),
  });
  return res.status;
}

async function reservarMedia(filename: string): Promise<Reservation> {
  const res = await api.request({
    method: "POST",
    path: "/api/v1/media/upload-url",
    body: {
      filename,
      contentType: "image/png",
      sizeBytes: PNG_1X1.byteLength,
    },
  });
  expect(res.status).toBe(200);
  return asReservation(dataOf(res));
}

/* ── 1 · el circuito entero ─────────────────────────────────────────────── */

describe(`POST /media — reserva → PUT → finalización${suffix}`, () => {
  itS3(
    "la `uploadUrl` es una firma real contra el bucket, no una sintética",
    async () => {
      const reservation = await reservarMedia("real.png");

      // La regresión concreta: con `MemoryStorage` esto era `memory://bucket/...`.
      expect(reservation.uploadUrl.startsWith(CONFIG?.endpoint ?? "")).toBe(true);
      expect(reservation.uploadUrl).toContain("X-Amz-Signature");
      expect(reservation.method).toBe("PUT");
      // §9.8: el cliente tiene que poder reproducir la petición firmada.
      expect(reservation.headers["Content-Type"]).toBe("image/png");
      expect(reservation.headers["Content-Length"]).toBe(String(PNG_1X1.byteLength));
      // NFR-007: la clave del objeto nunca sale. Está dentro de la URL firmada
      // por necesidad, pero no como campo propio.
      expect(Object.keys(reservation)).not.toContain("storageKey");
    },
  );

  itS3("el PUT del cliente entra, y la finalización encuentra el objeto", async () => {
    const reservation = await reservarMedia("circuito.png");

    const put = await putDirecto(reservation, PNG_1X1);
    expect(put).toBe(200);

    const res = await api.request({
      method: "POST",
      path: "/api/v1/media",
      body: { uploadId: reservation.uploadId },
    });

    // **Éste es el número de la tarea.** Antes era `409`, siempre.
    expect(res.status).toBe(201);
    const asset = dataOf(res);
    expect(asset["mediaType"]).toBe("image");
    expect(asset["status"]).toBe("ready");
    expect(asset["filename"]).toBe("circuito.png");
    // El tamaño sale del `head()` del objeto real, no de lo que declaró el
    // cliente. Que coincida con los bytes que subimos es lo que prueba que el
    // `head` miró el objeto y no la fila.
    expect(asset["sizeMb"]).toBeCloseTo(PNG_1X1.byteLength / (1024 * 1024), 9);
  });

  itS3("sin el PUT, la finalización sigue dando 409 — el control positivo", async () => {
    // Sin este caso el `201` de arriba no dice nada: podría estar pasando por
    // cualquier razón. Acá el único cambio es no subir los bytes, y el
    // resultado tiene que ser el camino de §9.8 para "el objeto todavía no
    // está", que es recuperable y no un fallo de infraestructura.
    const reservation = await reservarMedia("sin-put.png");

    const res = await api.request({
      method: "POST",
      path: "/api/v1/media",
      body: { uploadId: reservation.uploadId },
    });
    expect(res.status).toBe(409);
    expect(errorOf(res).code).toBe("conflict");
  });

  itS3("finalizar dos veces: la segunda es 409 y no crea un segundo asset", async () => {
    const reservation = await reservarMedia("doble.png");
    expect(await putDirecto(reservation, PNG_1X1)).toBe(200);

    const primera = await api.request({
      method: "POST",
      path: "/api/v1/media",
      body: { uploadId: reservation.uploadId },
    });
    expect(primera.status).toBe(201);

    const segunda = await api.request({
      method: "POST",
      path: "/api/v1/media",
      body: { uploadId: reservation.uploadId },
    });
    expect(segunda.status).toBe(409);
    expect(errorOf(segunda).message).toContain("already finalized");

    const filas = await api.handle.sql`
      select count(*)::int as n from media
      where company_id = ${api.data.a.companyId}::uuid and filename = 'doble.png'
    `;
    expect((filas[0] as unknown as { n: number }).n).toBe(1);
  });

  itS3("una reserva de otro workspace es 404, no 409 ni 403 (§9.2)", async () => {
    const reservation = await reservarMedia("ajena.png");
    expect(await putDirecto(reservation, PNG_1X1)).toBe(200);

    // El objeto **está** en el bucket: si el scope se comprobara después del
    // `head`, esto sería un 201 para el workspace equivocado.
    const res = await api.request({
      method: "POST",
      path: "/api/v1/media",
      token: api.data.b.token,
      body: { uploadId: reservation.uploadId },
    });
    expect(res.status).toBe(404);
    expect(errorOf(res).code).toBe("not_found");
  });
});

/* ── 2 · la trampa 11, de punta a punta ─────────────────────────────────── */

describe(`la firma que emite la API ata el Content-Type${suffix}`, () => {
  itS3("un PUT con otro `Content-Type` es 403, no 200", async () => {
    // Trampa 11 del general: `@aws-sdk/s3-request-presigner` firma
    // `content-length;host` por defecto y **deja `content-type` afuera**, así
    // que una reserva hecha para `image/png` aceptaba un PUT de
    // `application/zip` con 200. `packages/adapters` lo cubre a nivel de
    // adaptador; lo que se mide acá es que la reserva que **emite la API** lo
    // lleve puesto, que es lo que ve un cliente real.
    const reservation = await reservarMedia("tipo-cambiado.png");

    const status = await putDirecto(reservation, PNG_1X1, {
      "Content-Type": "application/zip",
    });
    expect(status).toBe(403);

    // Y como el PUT no entró, la finalización sigue en 409: el objeto no está.
    const res = await api.request({
      method: "POST",
      path: "/api/v1/media",
      body: { uploadId: reservation.uploadId },
    });
    expect(res.status).toBe(409);
  });
});

/* ── 3 · los otros dos endpoints de reserva ─────────────────────────────── */

describe(`POST /influencers/base-image/upload-url${suffix}`, () => {
  itS3("firma contra el prefijo propio y el PUT entra", async () => {
    const res = await api.request({
      method: "POST",
      path: "/api/v1/influencers/base-image/upload-url",
      body: {
        filename: "base.png",
        contentType: "image/png",
        sizeBytes: PNG_1X1.byteLength,
      },
    });
    expect(res.status).toBe(200);
    const reservation = asReservation(dataOf(res));

    // El prefijo no es el del Media Bank: `influencers/<company>/base-images`.
    // La clave no se devuelve (NFR-007) pero viaja en la ruta de la URL firmada.
    expect(reservation.uploadUrl).toContain(`influencers/${api.data.a.companyId}`);
    expect(reservation.uploadUrl).not.toContain(`/media/${api.data.a.companyId}`);

    expect(await putDirecto(reservation, PNG_1X1)).toBe(200);
  });
});

describe(`POST /content/custom/video — reserva → PUT → pieza${suffix}`, () => {
  /** Un MP4 mínimo: basta con que el objeto exista; nadie lo decodifica todavía. */
  const MP4 = new TextEncoder().encode("   ftypmp42fake-bytes");

  itS3("crea la pieza en BUILDING y encola el build", async () => {
    api.queue.reset();

    const reserva = await api.request({
      method: "POST",
      path: "/api/v1/content/custom/video/upload-url",
      body: { filename: "clip.mp4", contentType: "video/mp4", sizeBytes: MP4.byteLength },
    });
    // 201 acá y 200 en `/media/upload-url`: la asimetría es del PRD, no un bug.
    expect(reserva.status).toBe(201);
    const reservation = asReservation(dataOf(reserva));

    expect(await putDirecto(reservation, MP4)).toBe(200);

    const res = await api.request({
      method: "POST",
      path: "/api/v1/content/custom/video",
      body: { uploadId: reservation.uploadId },
    });
    expect(res.status).toBe(201);
    const content = dataOf(res);
    expect(content["type"]).toBe("custom");
    // FR-070: el archivo ya está, pero MOV→MP4 y el thumbnail los hace un job,
    // así que la pieza nace en BUILDING igual.
    expect(content["status"]).toBe("BUILDING");

    const jobs = api.queue.forQueue(JOB_QUEUES.contentBuild);
    expect(jobs).toHaveLength(1);
    expect((jobs[0]?.payload as { contentId?: string }).contentId).toBe(content["_id"]);
  });

  itS3(
    "sin el PUT es 409, y la reserva queda reintentable (no `finalizing`)",
    async () => {
      const reserva = await api.request({
        method: "POST",
        path: "/api/v1/content/custom/video/upload-url",
        body: {
          filename: "nunca-subido.mp4",
          contentType: "video/mp4",
          sizeBytes: MP4.byteLength,
        },
      });
      const reservation = asReservation(dataOf(reserva));

      const res = await api.request({
        method: "POST",
        path: "/api/v1/content/custom/video",
        body: { uploadId: reservation.uploadId },
      });
      expect(res.status).toBe(409);

      // La ruta marca `finalizing` **antes** del `head`. Si la transacción no
      // volviera atrás, la reserva quedaría muerta con un 409 eterno en vez de
      // recuperable. Esto es lo que mide que el rollback ocurre.
      const filas = await api.handle.sql`
      select state from upload_reservations where upload_id = ${reservation.uploadId}::uuid
    `;
      expect((filas[0] as unknown as { state: string }).state).toBe("reserved");

      // Y se puede terminar: se sube ahora y la misma reserva finaliza.
      expect(await putDirecto(reservation, MP4)).toBe(200);
      const segunda = await api.request({
        method: "POST",
        path: "/api/v1/content/custom/video",
        body: { uploadId: reservation.uploadId },
      });
      expect(segunda.status).toBe(201);
    },
  );
});

/* ── 4 · la URL que se persiste ─────────────────────────────────────────── */

describe(`la dirección estable del objeto${suffix}`, () => {
  itS3("`r2Url` no lleva firma: es la ruta del objeto, sin query (§9.10)", async () => {
    const reservation = await reservarMedia("persistida.png");
    expect(await putDirecto(reservation, PNG_1X1)).toBe(200);

    const res = await api.request({
      method: "POST",
      path: "/api/v1/media",
      body: { uploadId: reservation.uploadId },
    });
    const url = String(dataOf(res)["r2Url"]);

    // §9.10 prohíbe persistir una firmada: son capacidades bearer de una hora.
    expect(url).not.toContain("X-Amz-Signature");
    expect(url).not.toContain("?");
    expect(url.startsWith(`${CONFIG?.publicUrl ?? ""}/`)).toBe(true);
  });

  itS3("y hoy coincide con `S3_PUBLIC_URL` sólo porque no hay CDN delante", async () => {
    // El hueco reportado hace dos tandas, medido en vez de recordado.
    //
    // `canonicalObjectUrl` firma y tira la query, así que devuelve la ruta del
    // objeto **en el endpoint de firma**. En desarrollo el endpoint de MinIO y
    // la URL pública son el mismo host y el bucket va en la ruta en los dos
    // casos, así que son iguales. Con R2 detrás de un CDN
    // (`S3_PUBLIC_URL=https://cdn…`) dejan de serlo y lo persistido apunta a
    // `<account>.r2.cloudflarestorage.com`, que no sirve nada públicamente.
    //
    // Este caso pasa a rojo **justo** el día en que alguien ponga un CDN, que
    // es el día en que hay que arreglar `@fastgram/adapters`. Es la alarma, no
    // la solución.
    if (CONFIG === null) return;
    const url = await canonicalObjectUrl(storageFrom(CONFIG), "media/probe/objeto.png");
    expect(url).toBe(`${CONFIG?.publicUrl ?? ""}/media/probe/objeto.png`);
  });
});
