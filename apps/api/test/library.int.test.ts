/**
 * Biblioteca global de assets — sprint 9 (agente N), `PU-S9-005/006`, D-19.
 *
 * Contra Postgres de verdad, `MemoryStorage` propio y el HTTP de Wikimedia
 * Commons **grabado** (la respuesta real de su API, 2026-09-28, en
 * `packages/core/src/library/__fixtures__`): `fetch` global se reemplaza por
 * uno que sirve esos JSON. Ninguna llamada real.
 *
 * Lo que se mide:
 *  - owner-level: la marca activa no cambia nada; «use-in-brand» sí es de la marca;
 *  - fuentes: Commons sin key; Pexels deshabilitada hasta guardar la key
 *    (que queda `0600` y nunca sale);
 *  - buscar: la licencia la verifica el servidor (BY-SA, dominio público no importables);
 *  - importar: re-pide el archivo, crea la fila `processing` y encola con el
 *    link de la fuente; repetir = `duplicate`; BY-SA = `rejected`;
 *  - subida manual: la declaración es obligatoria (CC BY sin atribución → 400),
 *    confirmar crea la fila y encola;
 *  - editar revalida el JSON y marca `edited`; ocultar saca de la lista;
 *  - usar en marca copia al Media Bank de la marca activa con su categoría.
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { FixedClock, MemoryStorage } from "@fastgram/adapters";
import { JOB_QUEUES, type LibraryImportJob } from "@fastgram/core";
import { libraryAssetRepository, libraryAssets } from "@fastgram/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { dataOf, errorOf, startApi, type ApiHarness } from "./helpers/harness.js";

const HEADER = "x-fastgram-workspace";
const fixture = (name: string): string =>
  readFileSync(
    fileURLToPath(
      new URL(`../../../packages/core/src/library/__fixtures__/${name}`, import.meta.url),
    ),
    "utf8",
  );
const SEARCH = JSON.parse(fixture("wikimedia-search-green-screen.json")) as {
  query: { pages: { title: string }[] };
};

let api: ApiHarness;
const storage = new MemoryStorage(new FixedClock("2026-09-28T12:00:00.000Z"));
const asked: string[] = [];
const realFetch = globalThis.fetch;

/** Commons grabado: la búsqueda, o un archivo puntual sacado de la misma respuesta. */
async function fakeCommons(input: string | URL | Request): Promise<Response> {
  const url = new URL(
    typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
  );
  asked.push(url.href);
  if (url.hostname !== "commons.wikimedia.org")
    return new Response("nope", { status: 404 });
  const titles = url.searchParams.get("titles");
  if (titles === null) {
    return new Response(fixture("wikimedia-search-green-screen.json"), { status: 200 });
  }
  const pages = SEARCH.query.pages.filter((p) => p.title === titles);
  const fromFile =
    titles === "File:Scales Symbol of Law Green Screen.webm"
      ? fixture("wikimedia-file-scales.json")
      : JSON.stringify({ query: { pages } });
  return new Response(fromFile, { status: 200 });
}

beforeAll(async () => {
  vi.stubGlobal("fetch", vi.fn(fakeCommons));
  api = await startApi({ now: "2026-09-28T12:00:00.000Z", mode: "personal", storage });
}, 180_000);

afterAll(async () => {
  vi.stubGlobal("fetch", realFetch);
  await api?.close();
});

beforeEach(async () => {
  asked.length = 0;
  api.queue.reset();
  await api.handle.db.delete(libraryAssets);
});

const V = "/api/v1/library";

/** Lo que haría el worker: la fila pasa a `ready` con un JSON válido y su objeto. */
async function markReady(id: string): Promise<void> {
  const row = await libraryAssetRepository.findById(api.handle.db, id);
  if (row === null) throw new Error("sin fila");
  const key = `library/${id}/asset.mp4`;
  await storage.put({ key, body: new Uint8Array(2048), contentType: "video/mp4" });
  await libraryAssetRepository.update(api.handle.db, id, {
    status: "ready",
    kind: "green_screen_video",
    storageKey: key,
    url: `https://storage.test/${key}`,
    contentType: "video/mp4",
    sizeMb: 0.002,
    durationSec: 8.32,
    width: 1920,
    height: 1080,
    metadataSource: "auto",
    metadata: {
      schemaVersion: 1,
      kind: "green_screen_video",
      description: "",
      memeType: "other",
      emotions: [],
      useCases: [],
      characters: [],
      tags: ["scales"],
      language: null,
      hasSpeech: false,
      durationSec: 8.32,
      aspect: { ratio: "16:9", width: 1920, height: 1080 },
      framing: "object",
      chroma: { type: "green", keyQuality: 0.97, keyColor: "#00B140" },
      nsfw: false,
      energy: "medium",
      needsReview: true,
      license: row.license,
    },
  });
}

async function importScales(): Promise<string> {
  const res = await api.request({
    method: "POST",
    path: `${V}/sources/wikimedia/import`,
    body: { externalIds: ["File:Scales Symbol of Law Green Screen.webm"] },
  });
  expect(res.status).toBe(202);
  const [first] = res.body?.["data"] as { assetId: string; outcome: string }[];
  expect(first?.outcome).toBe("queued");
  return first?.assetId ?? "";
}

describe("fuentes", () => {
  it("Commons anda sin key; Pexels queda deshabilitada hasta guardar una (0600, nunca sale)", async () => {
    const before = await api.request({ method: "GET", path: `${V}/sources` });
    expect(before.status).toBe(200);
    const list = before.body?.["data"] as {
      id: string;
      enabled: boolean;
      disabledReason: string | null;
    }[];
    expect(list.find((s) => s.id === "wikimedia")?.enabled).toBe(true);
    expect(list.find((s) => s.id === "pexels")).toMatchObject({
      enabled: false,
      disabledReason: "missing_key",
    });

    const search = await api.request({
      method: "GET",
      path: `${V}/sources/pexels/search?q=facepalm`,
    });
    expect(search.status).toBe(409);
    expect(errorOf(search).details).toMatchObject({ reason: "missing_key" });

    const saved = await api.request({
      method: "PUT",
      path: `${V}/sources/pexels/key`,
      body: { apiKey: "pexels-test-key-123" },
    });
    expect(saved.status).toBe(200);
    expect(dataOf(saved)).toMatchObject({ enabled: true, keyFrom: "file" });
    expect(saved.raw).not.toContain("pexels-test-key-123");
    const file = join(String(process.env["FASTGRAM_HOME"]), "library-sources.json");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    const removed = await api.request({
      method: "DELETE",
      path: `${V}/sources/pexels/key`,
    });
    expect(dataOf(removed)).toMatchObject({ enabled: false });
  });

  it("buscar en Commons: la licencia la verifica el servidor", async () => {
    const res = await api.request({
      method: "GET",
      path: `${V}/sources/wikimedia/search?q=green%20screen`,
      // Otra marca activa: owner-level, no cambia nada.
      headers: { [HEADER]: api.data.b.companyId },
    });
    expect(res.status).toBe(200);
    const body = dataOf(res) as {
      results: {
        title: string;
        importable: boolean;
        unimportableReason: string | null;
      }[];
      credit: { url: string };
    };
    expect(asked[0]).toContain("gsrsearch=green+screen+filetype%3Avideo");
    const bySa = body.results.find((r) => r.title === "Greenscreen Computer Animation");
    expect(bySa).toMatchObject({
      importable: false,
      unimportableReason: "license_not_accepted",
    });
    const cc0 = body.results.find((r) => r.title === "Arrow Moving Graphic");
    expect(cc0?.importable).toBe(true);
    expect(body.credit.url).toBe("https://commons.wikimedia.org");
  });
});

describe("importar de una fuente", () => {
  it("re-pide el archivo, crea la fila processing y encola con el link de la fuente", async () => {
    const assetId = await importScales();
    expect(asked.some((u) => u.includes("titles=File%3AScales"))).toBe(true);
    const [job] = api.queue.forQueue(JOB_QUEUES.libraryImport);
    const payload = job?.payload as LibraryImportJob;
    expect(payload.assetId).toBe(assetId);
    expect(payload.origin).toMatchObject({ kind: "remote", source: "wikimedia" });
    expect(payload.origin.kind === "remote" && payload.origin.downloadUrl).toMatch(
      /^https:\/\/upload\.wikimedia\.org\//,
    );
    const detail = await api.request({ method: "GET", path: `${V}/assets/${assetId}` });
    expect(dataOf(detail)).toMatchObject({
      status: "processing",
      provider: "wikimedia",
      metadata: null,
      license: { type: "cc-by", version: "3.0" },
    });

    // Otra vez: dedupe por la página de la fuente.
    const again = await api.request({
      method: "POST",
      path: `${V}/sources/wikimedia/import`,
      body: { externalIds: ["File:Scales Symbol of Law Green Screen.webm"] },
    });
    expect((again.body?.["data"] as { outcome: string; assetId: string }[])[0]).toEqual({
      externalId: "File:Scales Symbol of Law Green Screen.webm",
      outcome: "duplicate",
      assetId,
      reason: null,
    });
    expect(api.queue.forQueue(JOB_QUEUES.libraryImport)).toHaveLength(1);
  });

  it("un import fallido se reintenta importándolo otra vez (misma fila, job nuevo)", async () => {
    const assetId = await importScales();
    await libraryAssetRepository.update(api.handle.db, assetId, {
      status: "failed",
      failureCode: "source_rate_limited",
    });
    const again = await api.request({
      method: "POST",
      path: `${V}/sources/wikimedia/import`,
      body: { externalIds: ["File:Scales Symbol of Law Green Screen.webm"] },
    });
    expect(
      (again.body?.["data"] as { outcome: string; assetId: string }[])[0],
    ).toMatchObject({
      outcome: "queued",
      assetId,
    });
    const jobs = api.queue.forQueue(JOB_QUEUES.libraryImport);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]?.options?.singletonKey).not.toBe(jobs[1]?.options?.singletonKey);
    const detail = await api.request({ method: "GET", path: `${V}/assets/${assetId}` });
    expect(dataOf(detail)).toMatchObject({ status: "processing", failureCode: null });
  });

  it("CC BY-SA no entra aunque el cliente lo pida por id", async () => {
    const res = await api.request({
      method: "POST",
      path: `${V}/sources/wikimedia/import`,
      body: { externalIds: ["File:Greenscreen Computer Animation.webm", "not-a-file"] },
    });
    expect(res.body?.["data"]).toEqual([
      {
        externalId: "File:Greenscreen Computer Animation.webm",
        outcome: "rejected",
        assetId: null,
        reason: "license_not_accepted",
      },
      {
        externalId: "not-a-file",
        outcome: "rejected",
        assetId: null,
        reason: "not_found",
      },
    ]);
    expect(api.queue.forQueue(JOB_QUEUES.libraryImport)).toHaveLength(0);
  });
});

describe("subida manual", () => {
  it("sin atribución para CC BY → 400; con licencia propia → reserva, confirma y encola", async () => {
    const bad = await api.request({
      method: "POST",
      path: `${V}/assets/uploads`,
      body: {
        filename: "clip.webm",
        contentType: "video/webm",
        sizeBytes: 4096,
        license: {
          type: "cc-by",
          sourceUrl: "https://example.org/clip",
          licenseUrl: "https://creativecommons.org/licenses/by/4.0/",
        },
      },
    });
    expect(bad.status).toBe(400);

    const reserved = await api.request({
      method: "POST",
      path: `${V}/assets/uploads`,
      body: {
        filename: "My reaction.webm",
        contentType: "video/webm",
        sizeBytes: 4096,
        license: { type: "own" },
      },
    });
    expect(reserved.status).toBe(201);
    const uploadId = String(dataOf(reserved)["uploadId"]);
    const rows = await api.handle.sql`
      select storage_key from upload_reservations where upload_id = ${uploadId}::uuid
    `;
    const key = String(rows[0]?.["storage_key"]);
    expect(key).toBe(`library/uploads/${uploadId}`);

    // Antes del PUT: el objeto no llegó.
    const early = await api.request({
      method: "POST",
      path: `${V}/assets/uploads/${uploadId}/complete`,
      body: {},
    });
    expect(early.status).toBe(409);

    await storage.put({ key, body: new Uint8Array(4096), contentType: "video/webm" });
    const done = await api.request({
      method: "POST",
      path: `${V}/assets/uploads/${uploadId}/complete`,
      body: {},
    });
    expect(done.status).toBe(202);
    expect(dataOf(done)).toMatchObject({
      title: "My reaction",
      status: "processing",
      provider: "upload",
      license: { type: "own" },
    });
    const [job] = api.queue.forQueue(JOB_QUEUES.libraryImport);
    expect(job?.payload).toMatchObject({
      origin: { kind: "upload", storageKey: key, contentType: "video/webm" },
    });
  });
});

describe("editar, ocultar, borrar y usar en marca", () => {
  it("editar revalida el JSON y marca edited; ocultar lo saca de la lista", async () => {
    const id = await importScales();
    const early = await api.request({
      method: "PATCH",
      path: `${V}/assets/${id}`,
      body: { description: "x" },
    });
    expect(early.status).toBe(409);

    await markReady(id);
    const edited = await api.request({
      method: "PATCH",
      path: `${V}/assets/${id}`,
      body: {
        description: "A judge's scale tips to one side.",
        memeType: "overlay_effect",
        emotions: ["neutral"],
        useCases: ["when weighing two options"],
      },
    });
    expect(edited.status).toBe(200);
    expect(dataOf(edited)).toMatchObject({
      metadataSource: "edited",
      metadata: { memeType: "overlay_effect", needsReview: false },
    });

    // El tipo no puede sostener lo que no se midió: sin croma no hay green screen.
    const wrong = await api.request({
      method: "PATCH",
      path: `${V}/assets/${id}`,
      body: { kind: "audio" },
    });
    expect(wrong.status).toBe(400);

    const found = await api.request({ method: "GET", path: `${V}/assets?q=weighing` });
    expect((found.body?.["data"] as { id: string }[]).map((a) => a.id)).toEqual([id]);

    await api.request({
      method: "PATCH",
      path: `${V}/assets/${id}`,
      body: { hidden: true },
    });
    const visible = await api.request({ method: "GET", path: `${V}/assets` });
    expect(visible.body?.["data"]).toEqual([]);
    const hidden = await api.request({
      method: "GET",
      path: `${V}/assets?status=hidden`,
    });
    expect((hidden.body?.["data"] as unknown[]).length).toBe(1);

    const del = await api.request({ method: "DELETE", path: `${V}/assets/${id}` });
    expect(del.status).toBe(204);
    const gone = await api.request({ method: "GET", path: `${V}/assets/${id}` });
    expect(gone.status).toBe(404);
  });

  it("usar en marca copia al Media Bank de la marca activa, con su categoría", async () => {
    const id = await importScales();
    await markReady(id);
    const res = await api.request({
      method: "POST",
      path: `${V}/assets/${id}/use-in-brand`,
      headers: { [HEADER]: api.data.b.companyId },
    });
    expect(res.status).toBe(201);
    const out = dataOf(res) as { target: string; targetId: string; url: string };
    expect(out.target).toBe("media");

    const inB = await api.request({
      method: "GET",
      path: `/api/v1/media/${out.targetId}`,
      headers: { [HEADER]: api.data.b.companyId },
    });
    expect(inB.status).toBe(200);
    expect(dataOf(inB)).toMatchObject({
      status: "ready",
      categories: ["green-screen-video"],
    });
    // En la marca `a` no existe: fue a la activa.
    const inA = await api.request({
      method: "GET",
      path: `/api/v1/media/${out.targetId}`,
    });
    expect(inA.status).toBe(404);
    // Es una copia: el objeto de la biblioteca sigue.
    expect(await storage.head(`library/${id}/asset.mp4`)).not.toBeNull();
    // (`MemoryStorage` codifica la clave en la URL.)
    expect(decodeURIComponent(out.url)).toContain(
      `media/${api.data.b.companyId}/library/`,
    );
  });

  it("un asset que procesa no se usa; un id que no es uuid es 404", async () => {
    const id = await importScales();
    const res = await api.request({
      method: "POST",
      path: `${V}/assets/${id}/use-in-brand`,
    });
    expect(res.status).toBe(409);
    const bad = await api.request({ method: "GET", path: `${V}/assets/nope` });
    expect(bad.status).toBe(404);
  });
});
