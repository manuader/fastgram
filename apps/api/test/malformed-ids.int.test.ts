/**
 * Un id que no es uuid no existe — `NFR-006`, PRD §9.2.
 *
 * ## El bug
 *
 * `GET /brand/sources/no-soy-un-uuid` y `GET /content/no-soy-un-uuid`
 * respondían **500**. Los ids del contrato son opacos (`z.string().min(1)`) y la
 * columna es `uuid`: Postgres no devuelve cero filas, levanta *invalid input
 * syntax for type uuid* (`22P02`) y eso sale como error nuestro por un dato del
 * cliente. `GET /posts/:id` ya daba 404 porque la ruta lo comprobaba a mano
 * (`isStorableId`); las otras rutas no, y cada ruta nueva era una oportunidad de
 * olvidarlo.
 *
 * ## Qué exige este archivo
 *
 * Para **cada** operación con `{param}` del OpenAPI (que `openapi-routes.test.ts`
 * obliga a coincidir con lo que Fastify registra), dos peticiones idénticas salvo
 * el id: una con un uuid bien formado que no existe y otra con basura. Tienen que
 * responder **lo mismo, byte a byte**. Eso es lo que `NFR-006` pide de verdad:
 * *"sin revelar nada"* no es "dar 404", es que el que sondea no pueda distinguir
 * un id inválido de uno inexistente. Para todas salvo el borrado idempotente de
 * media eso es un 404 `not_found`; `DELETE /media/:id` responde 204 a un id que no
 * existe (ver su ruta), y un id basura tiene que responder ese mismo 204.
 *
 * ## Por qué hace falta una tabla de cuerpos
 *
 * Porque sin cuerpo válido la validación del schema responde 400 **antes** de
 * llegar al handler, y 400 == 400 pasaría sin haber tocado la base: el test
 * sería verde por la razón equivocada (trampa 22). La guarda está en
 * {@link assertReachedHandler}: si el uuid inexistente devuelve 400, la
 * operación no se midió y el test falla pidiendo un cuerpo en {@link BODIES}.
 * Así una ruta nueva con `:id` entra sola al barrido — y si tiene cuerpo, el
 * barrido obliga a darle uno.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REEL_DEFAULT_THEME, buildOpenApiDocument } from "@fastgram/contracts";

import { API_V1_PREFIX } from "../src/server/app.js";
import { startApi, type ApiHarness, type Response } from "./helpers/harness.js";

let api: ApiHarness;

beforeAll(async () => {
  api = await startApi();
}, 180_000);

afterAll(async () => {
  await api?.close();
});

/** Varias formas de "no es un uuid": corto, con forma casi válida, inyección. */
const MALFORMED = [
  "no-soy-un-uuid",
  "00000000-0000-0000-0000-00000000000g",
  "1' or '1'='1",
] as const;

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * Un cuerpo que **pasa** el schema de cada operación con cuerpo. No tiene que
 * tener sentido para el negocio: tiene que llevar la petición hasta el handler,
 * que es donde el id toca la base.
 */
const BODIES: Readonly<Record<string, () => unknown>> = {
  "PATCH /blitz/angles/{id}": () => ({ title: "nuevo título" }),
  // `P1-BRANDPG-005`: el parámetro es un campo, no un id; con basura es 404.
  "POST /brand/profile/proposals/{field}": () => ({
    action: "dismiss",
    excerptRef: "x#y",
    expectedBrandRevision: 0,
  }),
  // `PU-LATER-004`: imágenes del personaje.
  "POST /influencers/{id}/images/estimate": () => ({ prompt: "at the gym" }),
  "POST /influencers/{id}/images": () => ({ prompt: "at the gym" }),
  "PATCH /media/{id}": () => ({ categories: ["slideshow-image"] }),
  "PATCH /content/{id}": () => ({
    revision: 1,
    textBoxes: [
      {
        id: "slide-0-text-0",
        text: "Texto",
        position: { x: 10, y: 20 },
        widthPercent: 80,
        font: { family: "anton", weight: 400, size: 48 },
        color: "#FFFFFF",
        stroke: { width: 2, color: "#000000" },
        background: null,
      },
    ],
  }),
  "POST /content/{id}/regenerate": () => ({}),
  "POST /content/{id}/schedule": () => ({
    scheduledAtUtc: new Date("2026-10-01T15:00:00.000Z").getTime(),
    targets: [{ platform: "tiktok", connectionId: api.data.a.connectionId, title: "t" }],
  }),
  "PATCH /brand/sources/{id}": () => ({ isPrimary: true }),
  "POST /brand/sources/{id}/assist": () => ({ bio: "Café de especialidad en Palermo." }),
  "PATCH /workspaces/{id}": () => ({ name: "Otra marca" }),
  // `:task` no es un uuid, pero una tarea inexistente tiene que dar el mismo 404.
  "PUT /models/{task}": () => ({ provider: "ollama", model: "cualquiera" }),
  // `PU-CAL-001` / `PU-CAL-002`. `{kind}` también recibe el id: un kind basura es 404.
  "POST /content/{id}/autoschedule": () => ({}),
  // Sprint 7 (publish-flow): editar un post y la caption con IA.
  "PATCH /posts/{id}": () => ({ caption: "nueva" }),
  "POST /content/{id}/caption": () => ({ platform: "instagram", mode: "regenerate" }),
  "PATCH /calendar/items/{kind}/{id}": () => ({
    scheduledAtUtc: new Date("2026-10-01T15:00:00.000Z").getTime(),
  }),
  // `PU-PUB-002`. `{platform}` también recibe el id: una plataforma basura es 404.
  "PUT /integrations/{platform}": () => ({ clientId: "client-id" }),
  "POST /connections/{platform}/callback": () => ({ state: "v1.x.y" }),
  // Inspiration (FR-040 adaptado): etiquetas de una referencia.
  "PATCH /inspiration/{itemId}": () => ({ tags: ["hooks"] }),
  // Sprint 7: biblioteca de audio de la marca.
  "PATCH /audio/library/{audioId}": () => ({ title: "otro nombre" }),
  // `FR-140`, `P4-ENGAGE-006…012`: Engagement (Reddit).
  "POST /engagement/leads/{leadId}/reply/generate": () => ({ regenerate: false }),
  "PUT /engagement/leads/{leadId}/reply": () => ({ text: "borrador" }),
  "POST /engagement/leads/{leadId}/send": () => ({ text: "respuesta", confirm: true }),
  "POST /engagement/leads/{leadId}/mark-sent": () => ({ text: "respuesta" }),
  // Sprint 7 (agente G): formatos generativos e influencers.
  "POST /ai-studio/formats/{format}/estimate": () => ({ overlayText: "texto" }),
  "POST /ai-studio/formats/{format}/runs": () => ({ overlayText: "texto" }),
  // Sprint 8 (agente L): formatos con voz.
  "POST /ai-studio/speaking/{format}/script": () => ({ durationSeconds: 5 }),
  "POST /ai-studio/speaking/{format}/estimate": () => ({
    script: "texto",
    durationSeconds: 5,
  }),
  "POST /ai-studio/speaking/{format}/runs": () => ({
    script: "texto",
    durationSeconds: 5,
  }),
  "PUT /influencers/{id}/config": () => ({ angleIds: [] }),
  "POST /influencers/{id}/videos/estimate": () => ({
    sourceMediaId: randomUUID(),
    model: "kling-video/v2.6/pro/image-to-video",
    durationSeconds: 5,
  }),
  "POST /influencers/{id}/videos": () => ({
    sourceMediaId: randomUUID(),
    model: "kling-video/v2.6/pro/image-to-video",
    durationSeconds: 5,
  }),
  // `FR-150`, `P3-AUTO-001…013`: Automations.
  "PATCH /automations/{automationId}": () => ({ name: "Otro nombre" }),
  "PATCH /automations/{automationId}/slots/{slotId}": () => ({
    scheduledAt: new Date("2026-10-01T15:00:00.000Z").getTime(),
  }),
  "POST /automations/{automationId}/slots/{slotId}/reroll": () => ({}),
  // Sprint 8 (K): biblioteca de modelos del dueño.
  "PATCH /character-models/{id}": () => ({ name: "Otro nombre" }),
  "PUT /character-models/{id}/brands": () => ({ brandIds: [] }),
  "POST /character-models/{id}/ugc": () => ({ brandId: randomUUID(), prompt: "selfie" }),
  "POST /character-models/{id}/ugc/estimate": () => ({
    brandId: randomUUID(),
    prompt: "selfie",
  }),
  "POST /character-models/{id}/ugc/animate": () => ({
    brandId: randomUUID(),
    sourceMediaId: randomUUID(),
    model: "kling-video/v2.6/pro/image-to-video",
    durationSeconds: 5,
  }),
  "POST /character-models/{id}/ugc/animate/estimate": () => ({
    brandId: randomUUID(),
    sourceMediaId: randomUUID(),
    model: "kling-video/v2.6/pro/image-to-video",
    durationSeconds: 5,
  }),
  "POST /character-models/{id}/ugc/piece": () => ({
    brandId: randomUUID(),
    kind: "image",
    sourceMediaId: randomUUID(),
    texts: ["hola"],
  }),
  // Sprint 9 (M): design system por marca.
  "PATCH /design-system/{designSystemId}": () => ({ name: "FOCUS" }),
  "POST /design-system/{designSystemId}/generate": () => ({ localImages: 1 }),
  // Sprint 9 (S): la preferencia de logo de la marca.
  "PUT /design-system/{designSystemId}/logo-layer": () => ({
    enabled: true,
    corner: "top-right",
    size: "small",
    opacity: 0.9,
  }),
  // Sprint 9 (N): biblioteca global. `{source}` también recibe el id: una fuente
  // basura es 404, igual que una inexistente.
  "PATCH /library/assets/{id}": () => ({ title: "otro título" }),
  "PUT /library/sources/{source}/key": () => ({ apiKey: "una-key-de-prueba" }),
  "POST /library/sources/{source}/import": () => ({ externalIds: ["x"] }),
  // Sprint 9 (R): ads. Pasan el schema; la campaña inexistente es 404.
  "POST /ads/campaigns/{id}/activation-preview": () => ({ action: "activate" }),
  "POST /ads/campaigns/{id}/activate": () => ({ confirmationToken: "token" }),
  "PATCH /ads/campaigns/{id}/budget": () => ({ dailyCapMinor: 100, totalCapMinor: 1000 }),
  // Sprint 9 (P): el spec más chico que pasa el schema.
  "PUT /content/{id}/reel": () => ({
    revision: 1,
    reel: {
      version: 1,
      durationSec: 5,
      canvas: { width: 1080, height: 1920 },
      fps: 30,
      language: "en",
      theme: REEL_DEFAULT_THEME,
      mix: { duckMusic: false, duckLevel: 0.3 },
      layers: [
        {
          id: "bg",
          kind: "background",
          start: 0,
          end: 5,
          z: 0,
          fill: { type: "color", color: "#000000" },
          transitionIn: { kind: "cut", durationSec: 0.3 },
        },
      ],
    },
  }),
};

/**
 * La query que una operación `GET` necesita para pasar el schema, por la misma
 * razón que {@link BODIES}: sin ella responde 400 antes del handler.
 */
const QUERIES: Readonly<Record<string, string>> = {
  "GET /library/sources/{source}/search": "q=facepalm",
};

interface Operation {
  readonly method: Method;
  /** Con la notación del OpenAPI: `/content/{id}/schedule`. */
  readonly path: string;
}

function parameterizedOperations(): Operation[] {
  const doc = buildOpenApiDocument();
  const out: Operation[] = [];
  for (const [path, operations] of Object.entries(doc.paths)) {
    if (!path.includes("{")) continue;
    for (const method of Object.keys(operations)) {
      out.push({ method: method.toUpperCase() as Method, path });
    }
  }
  return out;
}

const opKey = (op: Operation): string => `${op.method} ${op.path}`;

function send(op: Operation, id: string): Promise<Response> {
  const body = BODIES[opKey(op)];
  return api.request({
    method: op.method,
    // Todos los parámetros de ruta de la v1 son ids; si mañana aparece uno que
    // no lo es, este reemplazo lo va a tratar como id y el test lo dirá.
    path:
      `${API_V1_PREFIX}${op.path.replace(/\{[^}]+\}/g, encodeURIComponent(id))}` +
      (QUERIES[opKey(op)] === undefined ? "" : `?${QUERIES[opKey(op)] ?? ""}`),
    // Una key nueva en cada petición: las rutas que la exigen la necesitan para
    // llegar al handler, y las que no la ignoran.
    idempotencyKey: randomUUID(),
    ...(body === undefined ? {} : { body: body() }),
  });
}

function assertReachedHandler(op: Operation, res: Response): void {
  expect(
    res.status,
    `${opKey(op)} con un uuid inexistente devolvió ${String(res.status)} ` +
      `(${res.raw.slice(0, 200)}): la petición no llegó al handler, así que el id ` +
      "basura tampoco llegaría a la base y el barrido no mide nada. Agregá un " +
      "cuerpo válido en BODIES.",
  ).not.toBe(400);
}

describe("un id que no es uuid responde igual que uno que no existe (NFR-006)", () => {
  const operations = parameterizedOperations();

  it("el barrido no está vacío", () => {
    // Si el OpenAPI dejara de exponer paths con parámetros (o cambiara la
    // notación), el `it.each` de abajo no correría nada y el archivo sería
    // verde sin medir. Esto no fija un número: fija que hay algo que medir.
    expect(operations.length).toBeGreaterThan(0);
  });

  it("cada operación del OpenAPI está registrada en Fastify con esa forma", () => {
    for (const op of operations) {
      const url = `${API_V1_PREFIX}${op.path.replace(/\{([^}]+)\}/g, ":$1")}`;
      expect(api.app.hasRoute({ method: op.method, url }), opKey(op)).toBe(true);
    }
  });

  it.each(parameterizedOperations().map((op) => [opKey(op), op] as const))(
    "%s",
    async (_name, op) => {
      const inexistente = await send(op, randomUUID());
      assertReachedHandler(op, inexistente);
      // El único 2xx admitido es el borrado idempotente: todo lo demás, 404.
      expect([404, 204], `${opKey(op)}: ${inexistente.raw.slice(0, 200)}`).toContain(
        inexistente.status,
      );

      for (const id of MALFORMED) {
        const basura = await send(op, id);
        expect(basura.status, `${opKey(op)} con "${id}": ${basura.raw}`).toBe(
          inexistente.status,
        );
        // Byte a byte: ni el mensaje ni `details` pueden distinguir "no es un
        // uuid" de "no existe". Un `details.reason: "malformed_id"` ya sería un
        // oráculo.
        expect(basura.raw, `${opKey(op)} con "${id}"`).toBe(inexistente.raw);
      }
    },
  );
});
