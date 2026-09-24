/**
 * Piezas que nacen **sin cajas** (Blitz, `POST /content`) en el editor.
 *
 * Bug visto en el navegador (2026-09-24): una pieza aceptada desde Blitz abría
 * `/library/:id/edit` con *"This piece has no editable text boxes"*: el accept
 * crea `contents` con `content_text_boxes` vacío y `GET /content/:id/editable`
 * devolvía sólo las guardadas.
 *
 * Lo que fija:
 *  - `GET /editable` sin cajas guardadas devuelve las derivadas del
 *    `buildPayload`, con los valores esperados, **sin escribirlas**;
 *  - el primer `PATCH` (con `revision`) acepta los ids derivados y guarda
 *    **todas** las cajas —las mandadas encima de las derivadas—, así que un
 *    `PATCH` parcial no borra texto de un slide;
 *  - después del `PATCH`, `GET /editable` trae las guardadas;
 *  - una pieza sin payload legible sigue siendo `422 content_not_editable`.
 */
import { randomUUID } from "node:crypto";
import { JOB_QUEUES } from "@fastgram/core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

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

const draw = (w: number, h: number) => ({
  url: "https://cdn.example.test/bg.jpg",
  drawX: 0,
  drawY: 0,
  drawW: w,
  drawH: h,
});

// Lo que escribe Blitz (`blitz-build.ts`, `textFor`) en un wall-of-text 1080×1920.
const BLITZ_TEXT = {
  content: "Consistency without burnout",
  x: 540,
  y: 1344,
  width: 972,
  fontSize: 18,
  color: "#FFFFFF",
  textAlign: "center",
  fontWeight: 700,
  strokeWidth: 3,
  strokeColor: "#000000",
};

const WALL = {
  canvas: { width: 1080, height: 1920 },
  video: draw(1080, 1920),
  text: BLITZ_TEXT,
};

const slide = (texts: unknown[]) => ({
  canvas: { width: 1080, height: 1350, aspectRatio: "4:5" },
  image: draw(1080, 1350),
  texts,
});

const SHOW = {
  num_images: 2,
  images: [
    slide([
      { ...BLITZ_TEXT, content: "Uno", y: 270 },
      {
        content: "Dos",
        x: 216,
        y: 1080,
        width: 540,
        fontSize: 24,
        color: "#FFD600",
        textAlign: "left",
        backgroundColor: "#112233",
      },
    ]),
    slide([{ ...BLITZ_TEXT, content: "Tres", y: 675 }]),
  ],
};

async function sinCajas(
  companyId: string,
  type: "wall-of-text" | "slideshow",
  payload: unknown,
): Promise<string> {
  const contentId = randomUUID();
  await api.handle.sql`
    insert into contents (id, company_id, type, status, revision, files, build_payload)
    values (${contentId}::uuid, ${companyId}::uuid, ${type}, 'CREATED', 1,
            ${["https://cdn.example.test/prev.mp4"]}::text[],
            ${JSON.stringify(payload)}::jsonb)
  `;
  return contentId;
}

const getEditable = (contentId: string) =>
  api.request({ method: "GET", path: `/api/v1/content/${contentId}/editable` });

type Box = {
  id: string;
  slideIndex?: number;
  text: string;
  position: { x: number; y: number };
  widthPercent: number;
  font: { family: string; weight: number; size: number };
  color: string;
  stroke: { width: number; color: string };
  background: { color: string; opacity: number; style: string } | null;
};

const boxesOf = async (contentId: string): Promise<Box[]> =>
  (dataOf(await getEditable(contentId)) as { textBoxes: Box[] }).textBoxes;

async function guardadas(contentId: string): Promise<{ id: string; text: string }[]> {
  const filas = await api.handle.sql`
    select id, text from content_text_boxes
    where content_id = ${contentId}::uuid order by id
  `;
  return filas as unknown as { id: string; text: string }[];
}

const patch = (contentId: string, textBoxes: unknown[]) =>
  api.request({
    method: "PATCH",
    path: `/api/v1/content/${contentId}`,
    body: { revision: 1, textBoxes },
    idempotencyKey: `derived-${randomUUID()}`,
  });

describe("GET /content/:id/editable sin cajas guardadas", () => {
  it("wall-of-text de Blitz: una caja derivada con los valores esperados", async () => {
    const id = await sinCajas(api.data.a.companyId, "wall-of-text", WALL);

    const res = await getEditable(id);

    expect(res.status).toBe(200);
    const data = dataOf(res) as { canvas: unknown; textBoxes: Box[] };
    expect(data.canvas).toEqual({ width: 1080, height: 1920 });
    expect(data.textBoxes).toEqual([
      {
        id: "slide-0-text-0",
        slideIndex: 0,
        text: "Consistency without burnout",
        position: { x: 50, y: 70 },
        widthPercent: 90,
        font: { family: "inter", weight: 700, size: 18 },
        color: "#FFFFFF",
        stroke: { width: 3, color: "#000000" },
        background: null,
      },
    ]);
    // GET no muta.
    expect(await guardadas(id)).toEqual([]);
  });

  it("slideshow: N cajas, una por texto, con defaults del render donde el payload omite", async () => {
    const id = await sinCajas(api.data.a.companyId, "slideshow", SHOW);

    const boxes = await boxesOf(id);

    expect(boxes.map((b) => [b.id, b.slideIndex, b.text])).toEqual([
      ["slide-0-text-0", 0, "Uno"],
      ["slide-0-text-1", 0, "Dos"],
      ["slide-1-text-0", 1, "Tres"],
    ]);
    expect(boxes[0]?.position).toEqual({ x: 50, y: 20 });
    expect(boxes[1]).toMatchObject({
      position: { x: 20, y: 80 },
      widthPercent: 50,
      font: { family: "inter", weight: 400, size: 24 },
      color: "#FFD600",
      stroke: { width: 3, color: "#000000" },
      background: { color: "#112233", opacity: 1, style: "pill" },
    });
    expect(boxes[2]?.position).toEqual({ x: 50, y: 50 });
    expect(await guardadas(id)).toEqual([]);
  });

  it("de otro workspace: 404, no las cajas derivadas", async () => {
    const id = await sinCajas(api.data.b.companyId, "wall-of-text", WALL);
    const res = await getEditable(id);
    expect(res.status).toBe(404);
  });
});

describe("primer PATCH sobre una pieza sin cajas", () => {
  it("acepta los ids derivados, guarda y encola un rebuild; después GET trae las guardadas", async () => {
    const id = await sinCajas(api.data.a.companyId, "wall-of-text", WALL);
    const [derivada] = await boxesOf(id);
    if (derivada === undefined) throw new Error("sin caja derivada");

    const res = await patch(id, [{ ...derivada, text: "Editado" }]);

    expect(res.status).toBe(200);
    expect(api.queue.forQueue(JOB_QUEUES.contentRebuild)).toHaveLength(1);
    expect(await guardadas(id)).toEqual([{ id: "slide-0-text-0", text: "Editado" }]);
    const despues = await boxesOf(id);
    expect(despues).toEqual([{ ...derivada, text: "Editado" }]);
  });

  it("PATCH parcial en un slideshow: guarda todas, las no mandadas tal como se derivaron", async () => {
    const id = await sinCajas(api.data.a.companyId, "slideshow", SHOW);
    const derivadas = await boxesOf(id);
    const segunda = derivadas.find((b) => b.id === "slide-0-text-1");
    if (segunda === undefined) throw new Error("falta slide-0-text-1");

    const res = await patch(id, [{ ...segunda, text: "Dos editado" }]);

    expect(res.status).toBe(200);
    expect(await guardadas(id)).toEqual([
      { id: "slide-0-text-0", text: "Uno" },
      { id: "slide-0-text-1", text: "Dos editado" },
      { id: "slide-1-text-0", text: "Tres" },
    ]);
    // El orden de las guardadas es el del repositorio, no el de los ids: el
    // rebuild ordena por id (`applyTextBoxesToBuildPayload`), así que da igual.
    const despues = (await boxesOf(id)).sort((x, y) => x.id.localeCompare(y.id));
    expect(despues).toEqual(
      derivadas.map((b) =>
        b.id === "slide-0-text-1" ? { ...b, text: "Dos editado" } : b,
      ),
    );
  });

  it("un id que no es de los derivados: 400 sin escribir nada", async () => {
    const id = await sinCajas(api.data.a.companyId, "wall-of-text", WALL);
    const [derivada] = await boxesOf(id);
    if (derivada === undefined) throw new Error("sin caja derivada");

    const res = await patch(id, [{ ...derivada, id: "slide-0-text-9" }]);

    expect(res.status).toBe(400);
    expect(errorOf(res).code).toBe("bad_request");
    expect(await guardadas(id)).toEqual([]);
    expect(api.queue.forQueue(JOB_QUEUES.contentRebuild)).toHaveLength(0);
  });

  it("sin buildPayload legible sigue siendo 422 content_not_editable", async () => {
    const id = await sinCajas(api.data.a.companyId, "wall-of-text", { roto: true });
    const res = await patch(id, [
      {
        id: "slide-0-text-0",
        slideIndex: 0,
        text: "x",
        position: { x: 50, y: 50 },
        widthPercent: 80,
        font: { family: "inter", weight: 400, size: 18 },
        color: "#FFFFFF",
        stroke: { width: 3, color: "#000000" },
        background: null,
      },
    ]);

    expect(res.status).toBe(422);
    expect(errorOf(res).code).toBe("content_not_editable");
  });
});
