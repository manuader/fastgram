/**
 * Las decisiones de `media.ts` que se pueden comprobar sin base de datos.
 *
 * Las cuatro que se fijan acá son las que no se deducen leyendo el código y que un
 * cambio inocente rompe sin ruido:
 *
 *  1. que `committed` de la base signifique "ya finalizada" y no "lista para
 *     finalizar" — son dos vocabularios para la misma máquina de estados;
 *  2. que lo que se guarda en `r2Url` **no lleve firma**, porque §9.10 prohíbe
 *     persistirla;
 *  3. que la clave del objeto no dependa del nombre de archivo que manda el cliente;
 *  4. que las categorías se validen contra el tipo del asset y no contra la unión.
 */
import { describe, expect, it } from "vitest";
import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import {
  imageContentTypeSchema,
  uploadReservationStateSchema,
  videoContentTypeSchema,
} from "@fastgram/contracts";

import { canFinalize } from "../../http/uploads.js";
import { ALLOWED_CATEGORIES, CATEGORY_SCHEMA } from "./media.js";
import { canonicalObjectUrl, extensionFor } from "../../support/upload-reservations.js";

const COMPANY = "11111111-1111-4111-8111-111111111111";
const NOW = 1_700_000_000_000;

const UPLOAD_STATES = uploadReservationStateSchema.options;
const UPLOAD_CONTENT_TYPES = [
  ...imageContentTypeSchema.options,
  ...videoContentTypeSchema.options,
];

const reservationIn = (state: (typeof UPLOAD_STATES)[number]) => ({
  uploadId: "22222222-2222-4222-8222-222222222222",
  companyId: COMPANY,
  status: state,
  expiresAtMs: NOW + 60_000,
});

describe("los estados de reserva son los mismos de un lado y del otro", () => {
  it("`ReservationStatus` de la API es exactamente `UPLOAD_RESERVATION_STATE`", () => {
    // Acá había una tabla de traducción, en dos copias, porque la API decía
    // `pending`/`completed` y la base `reserved`/`committed`. La traducción
    // funcionaba y era el síntoma: el arreglo fue alinear los nombres, así que
    // lo que queda por proteger es que no vuelvan a separarse.
    //
    // No alcanza con que compile: los estados llegan del repositorio como
    // `string` y el tipo no los mira. Por eso se comprueba en ejecución que
    // cada estado del contrato sea uno que `canFinalize` reconoce — y
    // `canFinalize` falla cerrado, así que un estado ajeno da `conflict`.
    const esperado: Record<(typeof UPLOAD_STATES)[number], string> = {
      reserved: "proceed",
      // `expired` tiene su propio código (`410 gone`, §9.8) y por eso no cae en
      // el mismo cajón que los demás.
      expired: "gone",
      finalizing: "conflict",
      committed: "conflict",
      failed: "conflict",
    };
    for (const state of UPLOAD_STATES) {
      const outcome = canFinalize(reservationIn(state), { companyId: COMPANY }, NOW);
      expect(outcome.kind).toBe(esperado[state]);
    }
  });

  it("`committed` no vuelve a finalizar: es el segundo cobro", () => {
    expect(
      canFinalize(reservationIn("committed"), { companyId: COMPANY }, NOW).kind,
    ).toBe("conflict");
  });
});

describe("extensionFor", () => {
  it("da una extensión a cada content type que §9.8 acepta", () => {
    // Un content type sin extensión produciría claves sin sufijo, y el CDN serviría el
    // objeto sin poder inferir el tipo. El caso a cubrir es el content type nuevo que
    // alguien agrega al enum sin tocar el mapa de extensiones.
    for (const contentType of UPLOAD_CONTENT_TYPES) {
      expect(extensionFor(contentType)).toMatch(/^\.[a-z0-9]+$/);
    }
  });

  it("elige la canónica cuando el tipo admite dos", () => {
    // `image/jpeg` acepta `.jpg` y `.jpeg` al subir, pero la clave usa una sola: si
    // dependiera del nombre que mandó el cliente, el mismo tipo produciría dos formas
    // de clave y cualquier barrido por sufijo se comería la mitad.
    expect(extensionFor("image/jpeg")).toBe(".jpg");
    expect(extensionFor("video/quicktime")).toBe(".mov");
  });
});

describe("canonicalObjectUrl", () => {
  it("devuelve la dirección del objeto sin la firma", async () => {
    const storage = new MemoryStorage(new FixedClock(NOW), "https://cdn.example.test");
    const url = await canonicalObjectUrl(storage, "media/company/asset.png");

    // Lo que se persiste en `r2Url` no puede ser una capacidad bearer de una hora
    // (§9.10). La firma vive en la query, así que lo que importa es que no quede nada
    // de query — ni `sig`, ni `download`, ni un `X-Amz-*` del adaptador real.
    expect(url).not.toContain("?");
    expect(url.startsWith("https://cdn.example.test/")).toBe(true);
  });
});

describe("categorías por tipo (F-129 / FR-100)", () => {
  it("una imagen no acepta categorías de video, ni al revés", () => {
    expect(CATEGORY_SCHEMA.image.safeParse({ categories: ["hook-video"] }).success).toBe(
      false,
    );
    expect(
      CATEGORY_SCHEMA.video.safeParse({ categories: ["slideshow-image"] }).success,
    ).toBe(false);
  });

  it("la lista vacía es válida: es como se saca un asset de los pools de Blitz", () => {
    // FR-100 (PRD:1634) la nombra explícitamente, así que no es un caso borde que
    // alguien pueda "arreglar" pidiendo `min(1)`.
    expect(CATEGORY_SCHEMA.image.safeParse({ categories: [] }).success).toBe(true);
    expect(CATEGORY_SCHEMA.video.safeParse({ categories: [] }).success).toBe(true);
  });

  it("el `details` del 400 enumera exactamente las que entran", () => {
    expect([...ALLOWED_CATEGORIES.image]).toEqual([
      "slideshow-image",
      "green-screen-background",
    ]);
    expect([...ALLOWED_CATEGORIES.video]).toEqual([
      "background-video",
      "hook-video",
      "green-screen-video",
    ]);
  });
});
