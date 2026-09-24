/**
 * `httpDownloader` con ComfyUI (`PU-LATER-003`): las salidas de un ComfyUI
 * local salen por `http://…/view`, y eso se acepta **sólo** desde el origen
 * configurado. Contra un servidor HTTP local de prueba.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPortError } from "@fastgram/ports";

import { httpDownloader } from "./handler.js";

let server: Server;
let base: string;

beforeEach(async () => {
  server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "image/png" });
    res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const opts = { timeoutMs: 2000, maxBytes: 1024 };

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (isPortError(e)) return e.code;
    throw e;
  }
  return "ok";
}

describe("httpDownloader y el http:// de ComfyUI", () => {
  it("sin origen permitido, http:// se rechaza (como siempre)", async () => {
    expect(await code(httpDownloader(opts)(`${base}/view?filename=a.png`))).toBe(
      "provider_contract_violation",
    );
  });

  it("desde el origen de ComfyUI configurado, baja", async () => {
    const media = await httpDownloader({ ...opts, allowHttpOrigin: base })(
      `${base}/view?filename=a.png&subfolder=&type=output`,
    );
    expect(media.contentType).toBe("image/png");
    expect(media.body.byteLength).toBe(4);
  });

  it("http:// de otro origen no, aunque haya uno permitido", async () => {
    expect(
      await code(
        httpDownloader({ ...opts, allowHttpOrigin: "http://127.0.0.1:1" })(
          `${base}/view?filename=a.png`,
        ),
      ),
    ).toBe("provider_contract_violation");
  });
});
