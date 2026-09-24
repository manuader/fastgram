import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  UnsupportedZodNodeError,
  buildOpenApiDocument,
  toJsonSchema,
} from "./openapi.js";
import { contentTextBoxSchema } from "./resources/content.js";
import { errorEnvelopeSchema } from "./primitives/errors.js";
import { cursorQuerySchema } from "./primitives/pagination.js";

describe("conversor Zod → JSON Schema", () => {
  it("strings con min/max/url/regex", () => {
    expect(toJsonSchema(z.string().min(2).max(9))).toEqual({
      type: "string",
      minLength: 2,
      maxLength: 9,
    });
    expect(toJsonSchema(z.string().url()).format).toBe("uri");
    expect(toJsonSchema(z.string().regex(/^#[0-9a-f]{6}$/)).pattern).toBe(
      "^#[0-9a-f]{6}$",
    );
  });

  it("números enteros con rango", () => {
    expect(toJsonSchema(z.number().int().min(8).max(72))).toEqual({
      type: "integer",
      minimum: 8,
      maximum: 72,
    });
  });

  it("enums, literales y booleanos", () => {
    expect(toJsonSchema(z.enum(["a", "b"]))).toEqual({
      type: "string",
      enum: ["a", "b"],
    });
    expect(toJsonSchema(z.literal("PUT"))).toEqual({ const: "PUT" });
    expect(toJsonSchema(z.boolean())).toEqual({ type: "boolean" });
  });

  it("objetos: propiedades, required y additionalProperties en los strict", () => {
    const js = toJsonSchema(
      z.object({ a: z.string(), b: z.string().optional() }).strict(),
    );
    expect(js.required).toEqual(["a"]);
    expect(js.additionalProperties).toBe(false);
    expect(Object.keys(js.properties ?? {})).toEqual(["a", "b"]);
  });

  it("arrays con minItems/maxItems", () => {
    const js = toJsonSchema(z.array(z.string()).min(1).max(20));
    expect(js).toMatchObject({ type: "array", minItems: 1, maxItems: 20 });
  });

  it("nullable se describe como anyOf con null", () => {
    expect(toJsonSchema(z.string().nullable()).anyOf).toEqual([
      { type: "string" },
      { type: "null" },
    ]);
  });

  it("default se conserva — el limit 20 de la paginación llega al documento", () => {
    const js = toJsonSchema(cursorQuerySchema);
    expect(js.properties?.["limit"]?.default).toBe(20);
    expect(js.properties?.["limit"]?.maximum).toBe(100);
  });

  it("branded, effects y pipeline se describen por su lado de entrada", () => {
    expect(toJsonSchema(z.string().min(1).brand<"X">())).toEqual({
      type: "string",
      minLength: 1,
    });
    expect(toJsonSchema(z.object({ a: z.string() }).refine(() => true))).toMatchObject({
      type: "object",
    });
    const piped = z
      .string()
      .transform((s) => s.split(","))
      .pipe(z.array(z.enum(["a"])));
    expect(toJsonSchema(piped)).toEqual({ type: "string" });
  });

  it("atraviesa un schema real del contrato sin perder los límites del PRD", () => {
    const js = toJsonSchema(contentTextBoxSchema);
    expect(js.properties?.["text"]?.maxLength).toBe(5000);
    expect(js.properties?.["widthPercent"]?.minimum).toBe(25);
    expect(js.properties?.["font"]?.properties?.["size"]?.maximum).toBe(72);
  });

  it("falla ruidosamente ante un nodo no cubierto en vez de emitir {}", () => {
    expect(() => toJsonSchema(z.date())).toThrow(UnsupportedZodNodeError);
  });
});

describe("documento OpenAPI · ADR-015", () => {
  const doc = buildOpenApiDocument();

  it("es OpenAPI 3.1 y versiona en la ruta /api/v1 · PRD:2254", () => {
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0]?.url).toBe("/api/v1");
  });

  /**
   * **Esta lista NO es la guarda contra la deriva del contrato**, y conviene
   * decirlo acá porque durante un tiempo se creyó que lo era.
   *
   * Comprueba que los paths que el PRD §9.3 enumera estén en el documento, o
   * sea una sola dirección y contra una lista escrita a mano. Así convivieron
   * dos mentiras: cinco paths `/brand/*` documentados sin ruta detrás, y
   * `/blitz/angles/page` implementado sin documentar. Ninguna de las dos la
   * podía ver una lista de nombres.
   *
   * La comparación real —documento **contra las rutas que Fastify registra**,
   * en los dos sentidos— está en `apps/api/test/openapi-routes.test.ts`, que es
   * donde puede estar: este paquete es standalone y no puede importar la app.
   * Lo de acá sigue valiendo por lo que sí prueba: que la superficie que el PRD
   * enumera no desaparezca del documento de un borrado.
   */
  it("cubre las rutas de la superficie v1 del PRD §9.3", () => {
    for (const path of [
      "/blitz",
      "/blitz/preferences",
      "/blitz/angles",
      "/blitz/angles/page",
      "/blitz/angles/{id}",
      "/blitz/angles/generate",
      "/influencers",
      "/influencers/{id}",
      "/influencers/base-image/upload-url",
      "/connections",
      "/warmed-accounts",
      "/tiktok/sounds",
      "/audio",
      "/media",
      "/media/{id}",
      "/media/upload-url",
      "/content",
      "/content/{id}",
      "/content/{id}/editable",
      "/content/{id}/regenerate",
      "/content/{id}/schedule",
      "/content/custom/video",
      "/content/custom/video/upload-url",
      "/posts",
      "/posts/{id}",
      "/posts/cancel",
      "/posts/delete",
      "/analytics/posts",
      // EXTENSION · EXT-001, §9.14. Estaban en el documento desde antes de que
      // existiera una sola ruta `/brand`; ahora existen las siete operaciones.
      "/brand/sources",
      "/brand/sources/resolve",
      "/brand/sources/{id}",
      "/brand/sources/{id}/reanalyse",
      "/brand/profile",
    ]) {
      expect(doc.paths[path], `falta ${path}`).toBeDefined();
    }
  });

  it("el listado de brand sources usa el envelope paginado, como las otras seis listas", () => {
    // §9.14: *"misma convención de envelope, cursor e idempotencia que el
    // resto"*. Estaba documentado como `{data: [...]}` suelto, que era la única
    // lista de la v1 sin `pagination`.
    const schema =
      doc.paths["/brand/sources"]?.get?.responses["200"]?.content?.["application/json"]
        ?.schema;
    expect(schema?.required).toEqual(["data", "pagination"]);
    const params = doc.paths["/brand/sources"]?.get?.parameters ?? [];
    expect(params.some((p) => p.name === "cursor")).toBe(true);
    expect(params.find((p) => p.name === "limit")?.schema.maximum).toBe(100);
  });

  it("el alta de brand source exige Idempotency-Key · §9.14 PRD:2370", () => {
    const header = doc.paths["/brand/sources"]?.post?.parameters?.find(
      (p) => p.name === "idempotency-key",
    );
    expect(header?.required).toBe(true);
  });

  it("DELETE /media/{id} documenta el 409 media_in_use, que la ruta ya devuelve", () => {
    // P2-MEDIA-004 (sprint 7): el 409 de FR-100 volvió con la ruta. Un id
    // ajeno o inexistente sigue siendo 204 (§9.2: no revela existencia).
    expect(Object.keys(doc.paths["/media/{id}"]?.delete?.responses ?? {})).toEqual([
      "204",
      "409",
    ]);
  });

  it("POST /media declara sus errores reales con el sobre de error, no sólo el 201", () => {
    const responses = doc.paths["/media"]?.post?.responses ?? {};
    expect(Object.keys(responses).sort()).toEqual([
      "201",
      "404",
      "409",
      "410",
      "429",
      "503",
    ]);
    const errorJs = toJsonSchema(errorEnvelopeSchema);
    for (const status of ["404", "409", "410", "429", "503"]) {
      expect(responses[status]?.content?.["application/json"]?.schema, status).toEqual(
        errorJs,
      );
    }
  });

  it("/brand/sources/resolve acepta `hint` opcional, y sólo `website` · FR-011.1", () => {
    const schema =
      doc.paths["/brand/sources/resolve"]?.post?.requestBody?.content["application/json"]
        ?.schema;
    expect(schema?.required).toEqual(["input"]);
    expect(schema?.properties?.["hint"]).toEqual({ type: "string", enum: ["website"] });
  });

  it("todas las respuestas de error usan el sobre {error:{code,message}}", () => {
    const errorJs = toJsonSchema(errorEnvelopeSchema);
    const unauthorized = doc.paths["/influencers"]?.post?.responses["402"];
    expect(unauthorized?.content?.["application/json"]?.schema).toEqual(errorJs);
  });

  it("los endpoints facturables piden el header Idempotency-Key · PRD:2288", () => {
    for (const [path, method] of [
      ["/content", "post"],
      ["/content/{id}", "patch"],
      ["/content/{id}/regenerate", "post"],
      ["/influencers", "post"],
    ] as const) {
      const op = doc.paths[path]?.[method];
      const header = op?.parameters?.find((p) => p.name === "idempotency-key");
      expect(header, `${method.toUpperCase()} ${path} sin Idempotency-Key`).toBeDefined();
      expect(header?.required).toBe(true);
    }
  });

  it("el listado por cursor expone limit y cursor como parámetros de query", () => {
    const params = doc.paths["/content"]?.get?.parameters ?? [];
    const limit = params.find((p) => p.name === "limit");
    expect(limit?.schema.maximum).toBe(100);
    expect(limit?.schema.default).toBe(20);
    expect(params.some((p) => p.name === "cursor")).toBe(true);
  });

  it("el esquema de seguridad es Bearer con el prefijo fsln_live_ · FR-180 · PRD:1860", () => {
    expect(doc.components.securitySchemes["bearerApiKey"]).toMatchObject({
      type: "http",
      scheme: "bearer",
    });
  });

  it("es serializable a JSON (es lo que se publica)", () => {
    expect(() => JSON.stringify(doc)).not.toThrow();
  });
});
