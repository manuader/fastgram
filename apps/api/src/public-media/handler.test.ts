import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  deriveSigningKey,
  signPublicMediaToken,
  type ByteRange,
  type PublicMediaObjectSource,
} from "@fastgram/adapters/public-media";
import { createPublicMediaHandler, parseRange } from "./handler.js";

const NOW = 1_800_000_000;
const KEY = deriveSigningKey(Buffer.alloc(32, 1));
const OTHER_KEY = deriveSigningKey(Buffer.alloc(32, 2));
const BYTES = Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 251));

const objects = new Map<string, { body: Buffer; contentType: string }>([
  ["media/c1/photo.jpg", { body: BYTES, contentType: "image/jpeg" }],
  ["brand-snapshots/c1/raw", { body: Buffer.from("secret"), contentType: "text/html" }],
]);

const source: PublicMediaObjectSource = {
  async head(key) {
    const o = objects.get(key);
    return o === undefined
      ? null
      : { sizeBytes: o.body.length, contentType: o.contentType, etag: '"e1"' };
  },
  async read(key, range?: ByteRange) {
    const o = objects.get(key);
    if (o === undefined) throw new Error("missing");
    const slice =
      range === undefined ? o.body : o.body.subarray(range.start, range.end + 1);
    return (async function* () {
      yield slice.subarray(0, Math.floor(slice.length / 2));
      yield slice.subarray(Math.floor(slice.length / 2));
    })();
  },
};

let server: Server;
let base: string;
const logs: string[] = [];

beforeAll(async () => {
  const handler = createPublicMediaHandler({
    source,
    signingKey: KEY,
    now: () => NOW * 1000,
    log: (l) => logs.push(l),
  });
  server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
});

function token(objectKey: string, opts: { exp?: number; key?: Buffer } = {}): string {
  return signPublicMediaToken(opts.key ?? KEY, {
    objectKey,
    expiresAt: opts.exp ?? NOW + 3600,
  });
}

describe("GET /public-media/:token", () => {
  it("200 con Content-Type, Content-Length y los bytes exactos", async () => {
    const res = await fetch(`${base}/public-media/${token("media/c1/photo.jpg")}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(res.headers.get("content-length")).toBe("1000");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await res.arrayBuffer()).equals(BYTES)).toBe(true);
  });

  it("Range ⇒ 206 con los bytes correctos y Content-Range", async () => {
    const res = await fetch(`${base}/public-media/${token("media/c1/photo.jpg")}`, {
      headers: { Range: "bytes=100-199" },
    });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(res.headers.get("content-length")).toBe("100");
    expect(Buffer.from(await res.arrayBuffer()).equals(BYTES.subarray(100, 200))).toBe(
      true,
    );
  });

  it("Range de sufijo y abierto", async () => {
    const t = token("media/c1/photo.jpg");
    const suffix = await fetch(`${base}/public-media/${t}`, {
      headers: { Range: "bytes=-10" },
    });
    expect(suffix.status).toBe(206);
    expect(suffix.headers.get("content-range")).toBe("bytes 990-999/1000");
    expect(Buffer.from(await suffix.arrayBuffer()).equals(BYTES.subarray(990))).toBe(
      true,
    );
    const open = await fetch(`${base}/public-media/${t}`, {
      headers: { Range: "bytes=995-" },
    });
    expect(open.headers.get("content-range")).toBe("bytes 995-999/1000");
    expect((await open.arrayBuffer()).byteLength).toBe(5);
  });

  it("Range fuera del objeto ⇒ 416", async () => {
    const res = await fetch(`${base}/public-media/${token("media/c1/photo.jpg")}`, {
      headers: { Range: "bytes=5000-" },
    });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */1000");
  });

  it("If-Range que no coincide ⇒ objeto entero", async () => {
    const res = await fetch(`${base}/public-media/${token("media/c1/photo.jpg")}`, {
      headers: { Range: "bytes=0-9", "If-Range": '"otro"' },
    });
    expect(res.status).toBe(200);
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
  });

  it("HEAD ⇒ cabeceras sin cuerpo", async () => {
    const res = await fetch(`${base}/public-media/${token("media/c1/photo.jpg")}`, {
      method: "HEAD",
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe("1000");
  });

  it.each([
    ["vencido", () => token("media/c1/photo.jpg", { exp: NOW - 1 })],
    ["firmado con otra clave", () => token("media/c1/photo.jpg", { key: OTHER_KEY })],
    ["firmado pero fuera de media/ y content/", () => token("brand-snapshots/c1/raw")],
    ["objeto inexistente", () => token("media/c1/nope.jpg")],
    ["basura", () => "no-es-un-token"],
  ])("%s ⇒ 404 sin pistas", async (_name, make) => {
    const res = await fetch(`${base}/public-media/${make()}`);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found\n");
  });

  it.each([
    "/",
    "/health",
    "/api/v1/content",
    "/public-media/",
    "/public-media",
    `/public-media/${"x"}/extra`,
    "/fastgram-dev/media/c1/photo.jpg",
  ])("cualquier otra ruta (%s) ⇒ 404", async (path) => {
    const res = await fetch(`${base}${path}`);
    expect(res.status).toBe(404);
  });

  it("otro método en la ruta ⇒ 405", async () => {
    const res = await fetch(`${base}/public-media/${token("media/c1/photo.jpg")}`, {
      method: "DELETE",
    });
    expect(res.status).toBe(405);
  });

  it("el log no lleva el token", () => {
    const t = token("media/c1/photo.jpg");
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.some((l) => l.includes(t.slice(0, 20)))).toBe(false);
  });
});

describe("parseRange", () => {
  it("casos borde", () => {
    expect(parseRange(undefined, 10)).toEqual({ kind: "none" });
    expect(parseRange("bytes=0-1,5-6", 10)).toEqual({ kind: "none" });
    expect(parseRange("items=0-1", 10)).toEqual({ kind: "none" });
    expect(parseRange("bytes=-", 10)).toEqual({ kind: "none" });
    expect(parseRange("bytes=0-100", 10)).toEqual({
      kind: "range",
      range: { start: 0, end: 9 },
    });
    expect(parseRange("bytes=-100", 10)).toEqual({
      kind: "range",
      range: { start: 0, end: 9 },
    });
    expect(parseRange("bytes=5-2", 10)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=-0", 10)).toEqual({ kind: "unsatisfiable" });
    expect(parseRange("bytes=0-", 0)).toEqual({ kind: "unsatisfiable" });
  });
});
