/**
 * Las tres reglas de `content.ts` que no se pueden ver leyendo el handler.
 *
 * La suite es unitaria a propósito: `vitest.config.ts` de `apps/api` deja los
 * `.int.test.ts` fuera para que `pnpm test` siga significando algo en una máquina
 * sin Postgres. Lo que se afirma acá son funciones puras, así que no hace falta
 * levantar Fastify — y lo que necesitaría levantarlo (los 409, el 503 sin cola,
 * el replay de la key) queda anotado en el reporte como **no verificado**.
 */
import { describe, expect, it } from "vitest";
import { createContentRequestSchema } from "@fastgram/contracts";
import type { contentTextBoxes } from "@fastgram/db";

import { canFinalize, type ReservationStatus } from "../../http/uploads.js";
import { __testables } from "./content.js";

const { contentTypeOf, canvasOf, toContentTextBox } = __testables;

const canvas = { width: 1080, height: 1920 };
const media = {
  url: "https://cdn.test/a.mp4",
  drawX: 0,
  drawY: 0,
  drawW: 1080,
  drawH: 1920,
};
const text = {
  content: "hola",
  x: 0,
  y: 0,
  width: 1080,
  fontSize: 18,
  color: "#FFFFFF",
  textAlign: "center" as const,
};

describe("contentTypeOf · el tipo sale de la forma del payload", () => {
  // `POST /content` recibe el payload desnudo: el PRD no le pone clave
  // discriminante, así que si esta deducción se equivoca la pieza se guarda con
  // el tipo de otro formato y el worker compone algo que nadie pidió. Cada caso
  // pasa por el schema del contrato para que el test no afirme sobre un payload
  // que la ruta habría rechazado igual.
  it("reconoce wall-of-text", () => {
    const payload = createContentRequestSchema.parse({ canvas, video: media, text });
    expect(contentTypeOf(payload)).toBe("wall-of-text");
  });

  it("reconoce green-screen, que también tiene `video`", () => {
    const payload = createContentRequestSchema.parse({
      canvas,
      image: { ...media, url: "https://cdn.test/bg.png" },
      video: media,
      text,
    });
    expect(contentTypeOf(payload)).toBe("green-screen");
  });

  it("reconoce video-hook, que tiene dos videos", () => {
    const payload = createContentRequestSchema.parse({
      canvas,
      hook_video: media,
      demo_video: media,
      text,
    });
    expect(contentTypeOf(payload)).toBe("video-hook");
  });

  it("reconoce slideshow", () => {
    const payload = createContentRequestSchema.parse({
      num_images: 1,
      images: [
        {
          canvas: { ...canvas, aspectRatio: "9:16" },
          image: { ...media, url: "https://cdn.test/s0.png" },
          texts: [text],
        },
      ],
    });
    expect(contentTypeOf(payload)).toBe("slideshow");
  });
});

describe("canvasOf · el canvas de `GET /content/:id/editable`", () => {
  it("toma el canvas del payload en los formatos de una sola superficie", () => {
    expect(canvasOf({ canvas, video: media, text })).toEqual(canvas);
  });

  it("toma el del primer slide y descarta `aspectRatio`", () => {
    // `editableContentSchema.canvas` es el canvas pelado y `.strict()`: dejar
    // pasar `aspectRatio` haría fallar la validación del editor.
    const resolved = canvasOf({
      num_images: 1,
      images: [
        {
          canvas: { ...canvas, aspectRatio: "4:5" },
          image: { ...media, url: "https://cdn.test/s0.png" },
          texts: [],
        },
      ],
    });
    expect(resolved).toEqual(canvas);
  });

  it("devuelve null con un payload ausente o ilegible (ERR-F04)", () => {
    // Sin canvas no hay superficie: la ruta responde 422 content_not_editable en
    // vez de devolver cajas con coordenadas relativas a nada.
    expect(canvasOf(null)).toBeNull();
    expect(canvasOf({ legacy: "manifest" })).toBeNull();
    expect(canvasOf("no soy un objeto")).toBeNull();
  });
});

describe("RESERVATION_STATUS · la traducción que evita cobrar dos veces", () => {
  const reservation = (state: ReservationStatus, expiresAtMs: number) => ({
    uploadId: "up-1",
    companyId: "co-1",
    status: state,
    expiresAtMs,
  });
  const now = 1_000;
  const future = 10_000;

  it("`reserved` vigente es la única que finaliza", () => {
    expect(
      canFinalize(reservation("reserved", future), { companyId: "co-1" }, now),
    ).toEqual({ kind: "proceed" });
  });

  it("`committed` NO vuelve a finalizar", () => {
    // Es la razón de existir de la tabla: el schema dice `committed` y
    // `canFinalize` razona sobre `completed`. Sin traducir, este caso caía en
    // `proceed` y un segundo POST con el mismo uploadId creaba otra pieza.
    expect(
      canFinalize(reservation("committed", future), { companyId: "co-1" }, now).kind,
    ).toBe("conflict");
  });

  it("`finalizing` y `failed` son conflicto", () => {
    expect(
      canFinalize(reservation("finalizing", future), { companyId: "co-1" }, now).kind,
    ).toBe("conflict");
    expect(
      canFinalize(reservation("failed", future), { companyId: "co-1" }, now).kind,
    ).toBe("conflict");
  });

  it("`expired`, y también una `reserved` vencida, son 410", () => {
    expect(
      canFinalize(reservation("expired", future), { companyId: "co-1" }, now).kind,
    ).toBe("gone");
    expect(
      canFinalize(reservation("reserved", now - 1), { companyId: "co-1" }, now).kind,
    ).toBe("gone");
  });

  it("un estado que nadie previó es conflicto, no `proceed`", () => {
    // Acá había una tabla de traducción porque la API decía `pending` y la base
    // `committed`; se alinearon los nombres y la tabla sobró. Lo que queda por
    // proteger es lo otro: `canFinalize` falla **cerrado**, así que un estado
    // nuevo en `upload_reservation_state` da conflicto en vez de dejar crear
    // una segunda pieza y cobrar de nuevo.
    const raro = "quarantined" as ReservationStatus;
    expect(canFinalize(reservation(raro, future), { companyId: "co-1" }, now).kind).toBe(
      "conflict",
    );
  });
});

describe("toContentTextBox · fila de base → contrato", () => {
  const row = (
    overrides: Partial<typeof contentTextBoxes.$inferSelect> = {},
  ): typeof contentTextBoxes.$inferSelect => ({
    id: "slide-0-text-0",
    contentId: "cnt-1",
    companyId: "co-1",
    slideIndex: null,
    text: "hola",
    position: { x: 10, y: 20 },
    widthPercent: 50,
    font: { family: "inter", weight: 400, size: 18 },
    color: "#FFFFFF",
    stroke: { width: 3, color: "#000000" },
    background: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  });

  it("omite `slideIndex` cuando la columna es null", () => {
    // El contrato lo declara `.optional()` y el repo compila con
    // `exactOptionalPropertyTypes`: emitir `slideIndex: undefined` no es lo
    // mismo que omitirlo, y el `.strict()` del schema lo nota.
    expect("slideIndex" in toContentTextBox(row())).toBe(false);
    expect(toContentTextBox(row({ slideIndex: 2 })).slideIndex).toBe(2);
  });

  it("conserva `background: null`, que significa 'sin fondo'", () => {
    // DATA-009: `null` es una instrucción ("quitá el fondo"), no una ausencia.
    expect(toContentTextBox(row()).background).toBeNull();
  });

  it("no maquilla una fila corrupta: falla en vez de devolver una forma inválida", () => {
    // Las columnas de geometría son `jsonb` y Drizzle las tipa `unknown`. Con un
    // `as` en vez de un `parse`, esta fila saldría por la API prometiendo una
    // forma que no cumple.
    expect(() => toContentTextBox(row({ position: { x: 999, y: 0 } }))).toThrow();
    expect(() =>
      toContentTextBox(row({ font: { family: "anton", weight: 700 } })),
    ).toThrow();
  });
});
