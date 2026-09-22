/**
 * Lo que sostiene la Library y no se ve mirando la pantalla.
 *
 * Los tres bloques corresponden a las tres cosas que pueden romperse en
 * silencio: el schema (una pieza que no se puede leer desaparece de la lista
 * como si no existiera), el polling (si se apaga de más, `BUILDING` se queda
 * para siempre; si no se apaga nunca, la pestaña de fondo se come el rate
 * limit) y el aplanado del cursor (una página perdida es contenido que el
 * usuario no ve y nadie reporta).
 */
import { contentSchema, type ContentStatus } from "@fastgram/contracts";
import { describe, expect, it } from "vitest";
import type { CursorPage } from "../api/client";
import type { CursorPages } from "../api/hooks";
import {
  BUILD_POLL_INTERVAL_MS,
  fileKind,
  flattenPages,
  hasBuildingPiece,
  libraryContentSchema,
  pollIntervalFor,
  type LibraryContent,
} from "./content";

/** Una pieza recién creada, tal y como la serializa `apps/api`. */
const buildingFromServer = {
  _id: "11111111-1111-4111-8111-111111111111",
  type: "wall-of-text",
  status: "BUILDING",
  files: [],
  revision: 1,
  // Sin `thumbnailUrl`: `serializers.ts` omite el campo cuando la columna es
  // null, y en `BUILDING` siempre lo es.
};

const created = {
  ...buildingFromServer,
  status: "CREATED",
  files: ["https://cdn.example.test/a.mp4"],
  thumbnailUrl: "https://cdn.example.test/a.jpg",
};

describe("libraryContentSchema", () => {
  /**
   * Éste era el test que fijaba un **desacuerdo real** entre
   * `packages/contracts` y `apps/api`: el contrato declaraba `thumbnailUrl`
   * obligatorio y el servidor omite el campo en toda pieza en `BUILDING`.
   * Decía que se pondría rojo el día que el contrato se corrigiera, y **eso es
   * exactamente lo que pasó** — `expected true to be false`.
   *
   * Ahora afirma lo contrario, que es la propiedad que de verdad importa: una
   * pieza en construcción, tal como sale del servidor, **valida contra el
   * contrato**. Si alguien volviera a poner el campo obligatorio, esto cae.
   */
  it("una pieza en BUILDING, sin thumbnail, valida contra el contrato", () => {
    const strict = contentSchema.safeParse(buildingFromServer);
    expect(strict.success).toBe(true);
    expect(libraryContentSchema.safeParse(buildingFromServer).success).toBe(true);
  });

  it("no afloja nada más: un `status` que no existe sigue siendo un error", () => {
    const result = libraryContentSchema.safeParse({
      ...buildingFromServer,
      status: "ALMOST",
    });
    expect(result.success).toBe(false);
  });

  it("una pieza terminada pasa por los dos", () => {
    expect(contentSchema.safeParse(created).success).toBe(true);
    expect(libraryContentSchema.safeParse(created).success).toBe(true);
  });
});

describe("polling · ADR-014 / NFR-002", () => {
  const withStatus = (status: ContentStatus) => ({ status });

  it("con algo construyéndose, pregunta cada 10 s", () => {
    // El número es del PRD (PRD:2961), no una preferencia de esta pantalla.
    expect(BUILD_POLL_INTERVAL_MS).toBe(10_000);
    expect(pollIntervalFor([withStatus("CREATED"), withStatus("BUILDING")])).toBe(10_000);
  });

  it("sin nada construyéndose, se apaga", () => {
    expect(pollIntervalFor([withStatus("CREATED"), withStatus("FAILED")])).toBe(false);
    expect(pollIntervalFor([])).toBe(false);
  });

  it("`FAILED` no es `BUILDING`: un build que falló no se sigue consultando", () => {
    expect(hasBuildingPiece([withStatus("FAILED")])).toBe(false);
  });
});

describe("flattenPages", () => {
  const page = (
    items: readonly LibraryContent[],
    hasMore: boolean,
  ): CursorPage<LibraryContent> => ({ items, cursor: hasMore ? "next" : null, hasMore });

  it("sin datos, lista vacía y no una excepción", () => {
    expect(flattenPages(undefined)).toEqual([]);
  });

  it("concatena las páginas en orden", () => {
    const a = libraryContentSchema.parse(created);
    const b = libraryContentSchema.parse({
      ...created,
      _id: "22222222-2222-4222-8222-222222222222",
    });
    const data: CursorPages<LibraryContent> = {
      pages: [page([a], true), page([b], false)],
      pageParams: [null, "next"],
    };
    expect(flattenPages(data).map((item) => item._id)).toEqual([a._id, b._id]);
  });
});

describe("fileKind", () => {
  it("la extensión manda", () => {
    expect(fileKind("https://cdn.test/a.mp4", "slideshow")).toBe("video");
    expect(fileKind("https://cdn.test/a.png", "video-hook")).toBe("image");
  });

  it("una URL firmada no pierde la extensión por la query", () => {
    expect(fileKind("https://cdn.test/a.jpg?sig=abc&x=1", "video-hook")).toBe("image");
  });

  it("sin extensión, decide el tipo de la pieza", () => {
    expect(fileKind("https://cdn.test/files/abc", "slideshow")).toBe("image");
    expect(fileKind("https://cdn.test/files/abc", "wall-of-text")).toBe("video");
    expect(fileKind("https://cdn.test/files/abc", "green-screen")).toBe("video");
    expect(fileKind("https://cdn.test/files/abc", "video-hook")).toBe("video");
    // `custom` acepta imagen según F-070, pero sólo tiene endpoint de video.
    expect(fileKind("https://cdn.test/files/abc", "custom")).toBe("video");
  });
});
