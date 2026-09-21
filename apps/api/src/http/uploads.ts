/**
 * Política de subidas — PRD §9.8.
 *
 * Patrón obligatorio en tres pasos: **reserva** (los endpoints `upload-url`)
 * → **PUT
 * directo** al storage → **finalización** (`POST /media`). El archivo nunca
 * pasa por la API: con videos de 50 MB, proxearlos convertiría a la API en el
 * cuello de botella de un producto cuyo trabajo real es otro.
 *
 * Todo lo validable se valida en la RESERVA, antes de que el cliente suba un
 * solo byte. Rechazar un video de 50 MB después de subirlo gasta ancho de
 * banda de los dos lados para llegar a la misma respuesta.
 */

/** Límites del PRD §9.8. Los números son normativos. */
export const UPLOAD_KINDS = {
  image: {
    maxBytes: 10 * 1024 * 1024,
    contentTypes: ["image/jpeg", "image/png", "image/webp"],
  },
  video: {
    maxBytes: 50 * 1024 * 1024,
    contentTypes: ["video/mp4", "video/quicktime"],
  },
  /** Base image de influencer: mismo tope que una imagen normal. */
  influencerBaseImage: {
    maxBytes: 10 * 1024 * 1024,
    contentTypes: ["image/jpeg", "image/png", "image/webp"],
  },
} as const;

export type UploadKind = keyof typeof UPLOAD_KINDS;

/**
 * Extensiones aceptadas por content type. El PRD exige que la extensión del
 * filename COINCIDA con el content type declarado.
 *
 * No es burocracia: sin esto, un cliente sube `payload.html` declarando
 * `image/png`, el CDN lo sirve desde el mismo origen que la app, y el
 * navegador lo ejecuta. Es XSS almacenado por la puerta de atrás.
 */
const EXTENSIONS: Record<string, readonly string[]> = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "video/mp4": [".mp4"],
  "video/quicktime": [".mov"],
};

export type UploadRejection =
  | { code: "unsupported_content_type"; message: string }
  | { code: "file_too_large"; message: string; maxBytes: number }
  | { code: "extension_mismatch"; message: string };

export function validateUploadReservation(args: {
  kind: UploadKind;
  filename: string;
  contentType: string;
  sizeBytes: number;
}): UploadRejection | null {
  const spec = UPLOAD_KINDS[args.kind];

  if (!(spec.contentTypes as readonly string[]).includes(args.contentType)) {
    return {
      code: "unsupported_content_type",
      message: `Supported types: ${spec.contentTypes.join(", ")}`,
    };
  }

  if (args.sizeBytes > spec.maxBytes) {
    return {
      code: "file_too_large",
      message: `Maximum size is ${Math.floor(spec.maxBytes / 1024 / 1024)} MB`,
      maxBytes: spec.maxBytes,
    };
  }

  const allowed = EXTENSIONS[args.contentType] ?? [];
  const lower = args.filename.toLowerCase();
  if (!allowed.some((ext) => lower.endsWith(ext))) {
    return {
      code: "extension_mismatch",
      message: `A ${args.contentType} file must end in ${allowed.join(" or ")}`,
    };
  }

  return null;
}

/**
 * Estado de una reserva. Gobierna qué error devuelve la finalización.
 *
 * **Son los literales de `UPLOAD_RESERVATION_STATE` (`DATA-028`), no otros.**
 * Este tipo decía `pending`/`completed` mientras la base guarda
 * `reserved`/`committed`, y el efecto no era un error de tipos —las filas
 * llegan desde el repositorio como `string`— sino peor: un `committed` no
 * matcheaba ninguna rama y caía en `proceed`. O sea que **un segundo POST con
 * el mismo `uploadId` creaba otra pieza y cobraba de nuevo**. Lo encontró el
 * agente que escribió `POST /content/custom/video`.
 */
export type ReservationStatus =
  "reserved" | "finalizing" | "committed" | "failed" | "expired";

export interface Reservation {
  uploadId: string;
  companyId: string;
  status: ReservationStatus;
  expiresAtMs: number;
}

export type FinalizeOutcome =
  | { kind: "proceed" }
  /** PRD: reserva ajena → 404. No 403: no revelamos que el id existe. */
  | { kind: "not_found" }
  /** PRD: reserva expirada → 410 gone. */
  | { kind: "gone" }
  /** PRD: finalización en curso, o reserva previa fallida → 409 conflict. */
  | { kind: "conflict"; reason: string };

export function canFinalize(
  reservation: Reservation | null,
  requester: { companyId: string },
  nowMs: number,
): FinalizeOutcome {
  if (reservation === null) return { kind: "not_found" };

  // Se comprueba el tenant ANTES que cualquier otra cosa. Si se comprobara
  // después, un `410 gone` sobre la reserva de otro workspace confirmaría que
  // ese uploadId existe — exactamente la filtración que el PRD §9.2 prohíbe.
  if (reservation.companyId !== requester.companyId) return { kind: "not_found" };

  if (reservation.status === "finalizing") {
    return { kind: "conflict", reason: "finalization already in progress" };
  }
  if (reservation.status === "failed") {
    return { kind: "conflict", reason: "a previous reservation for this object failed" };
  }
  if (reservation.status === "committed") {
    return { kind: "conflict", reason: "this upload was already finalized" };
  }
  if (reservation.status === "expired" || nowMs > reservation.expiresAtMs) {
    return { kind: "gone" };
  }

  // Falla **cerrado**, y ésta es la parte estructural del arreglo.
  //
  // Alinear los literales con la base no alcanza: mientras el caso por defecto
  // fuera `proceed`, cualquier estado que no esté acá —uno nuevo en el enum, un
  // dato viejo, una migración a medias— pasaría de largo y volvería a permitir
  // la doble finalización. Con la lista explícita, el único estado que sigue es
  // el que dice que se puede seguir, y cualquier otro es un `conflict` ruidoso
  // en vez de un cobro silencioso.
  if (reservation.status !== "reserved") {
    return { kind: "conflict", reason: `unexpected reservation state` };
  }

  return { kind: "proceed" };
}
