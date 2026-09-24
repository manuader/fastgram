/**
 * Personajes de Higgsfield (Soul ID) contra un `fetch` que contesta **lo que
 * documenta** https://docs.higgsfield.ai (verificado el 2026-09-24):
 * `/docs/concepts/file-uploads`, `/docs/models/soul-id/create-character` y
 * `/docs/models/soul-2/generate`. Ninguna llamada real.
 */
import { describe, expect, it } from "vitest";
import { isPortError } from "@fastgram/ports";

import type { GenFetch } from "../genai/http.js";
import { HiggsfieldClient, type HiggsfieldUploadFetch } from "./client.js";

interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const BASE = "https://api.higgsfield.ai";
const CHAR_ID = "3eb3ad49-775d-40bd-b5e5-38b105108780";
const RID = "d7e6c0f3-6699-4f6c-bb45-2ad7fd9158ff";

function fake(respond: (req: Seen) => Response): { fetch: GenFetch; seen: Seen[] } {
  const seen: Seen[] = [];
  return {
    seen,
    fetch: (url, init) => {
      const req: Seen = {
        url,
        method: init.method,
        headers: init.headers,
        ...(init.body === undefined ? {} : { body: JSON.parse(init.body) as unknown }),
      };
      seen.push(req);
      return Promise.resolve(respond(req));
    },
  };
}

function client(fetch: GenFetch, uploadFetch?: HiggsfieldUploadFetch): HiggsfieldClient {
  return new HiggsfieldClient({
    baseUrl: BASE,
    apiKey: "KEYID:SECRET",
    fetch,
    timeoutMs: 1000,
    ...(uploadFetch === undefined ? {} : { uploadFetch }),
  });
}

async function portCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (isPortError(e)) return e.code;
    throw e;
  }
  throw new Error("expected a PortError");
}

/** La respuesta de `generate-upload-url` con los campos de la doc. */
const UPLOAD = {
  public_url: "https://cdn.higgsfield.ai/uploads/abc.jpg",
  upload_url: "https://storage.example-s3.com/abc.jpg?X-Amz-Signature=sig",
  content_type: "image/jpeg",
  upload_headers: { "Content-Type": "image/jpeg", "x-amz-tagging": "temp=true" },
};

describe("HiggsfieldClient — subir una foto de referencia", () => {
  it("pide la URL firmada con la credencial y hace PUT al storage SIN la credencial", async () => {
    const { fetch, seen } = fake(() => json(200, UPLOAD));
    const puts: { url: string; headers: Record<string, string>; size: number }[] = [];
    const uploadFetch: HiggsfieldUploadFetch = (url, init) => {
      puts.push({ url, headers: init.headers, size: init.body.byteLength });
      return Promise.resolve(new Response(null, { status: 200 }));
    };
    const url = await client(fetch, uploadFetch).uploadImage({
      body: new Uint8Array([1, 2, 3]),
      contentType: "image/jpeg",
    });
    expect(url).toBe(UPLOAD.public_url);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.url).toBe(`${BASE}/files/generate-upload-url`);
    expect(seen[0]?.headers["Authorization"]).toBe("Key KEYID:SECRET");
    expect(seen[0]?.body).toEqual({ content_type: "image/jpeg" });
    expect(puts).toHaveLength(1);
    expect(puts[0]?.url).toBe(UPLOAD.upload_url);
    // Exactamente los `upload_headers` y nada de la credencial.
    expect(puts[0]?.headers).toEqual(UPLOAD.upload_headers);
    expect(
      Object.keys(puts[0]?.headers ?? {}).some(
        (k) => k.toLowerCase() === "authorization",
      ),
    ).toBe(false);
    expect(puts[0]?.size).toBe(3);
  });

  it("rechaza un tipo que la doc no lista antes de llamar", async () => {
    const { fetch, seen } = fake(() => json(200, UPLOAD));
    expect(
      await portCode(
        client(fetch).uploadImage({
          body: new Uint8Array([1]),
          contentType: "image/heic",
        }),
      ),
    ).toBe("bad_request");
    expect(seen).toHaveLength(0);
  });

  it("un upload_url que no es https es una violación de contrato", async () => {
    const { fetch } = fake(() => json(200, { ...UPLOAD, upload_url: "http://x/y" }));
    expect(
      await portCode(
        client(fetch).uploadImage({
          body: new Uint8Array([1]),
          contentType: "image/png",
        }),
      ),
    ).toBe("provider_contract_violation");
  });

  it("un PUT rechazado por el storage se traduce, sin el cuerpo crudo", async () => {
    const { fetch } = fake(() => json(200, UPLOAD));
    const uploadFetch: HiggsfieldUploadFetch = () =>
      Promise.resolve(new Response("<Error>AccessDenied</Error>", { status: 403 }));
    expect(
      await portCode(
        client(fetch, uploadFetch).uploadImage({
          body: new Uint8Array([1]),
          contentType: "image/png",
        }),
      ),
    ).toBe("bad_request");
  });
});

describe("HiggsfieldClient — crear y consultar un personaje", () => {
  it("POST /v1/custom-references con model_version v2 e input_images", async () => {
    const { fetch, seen } = fake(() =>
      json(200, {
        id: CHAR_ID,
        name: "Emily",
        model_version: "v2",
        status: "queued",
        thumbnail_url: null,
        created_at: "2026-09-24T10:00:00Z",
        in_progress_at: null,
        fail_reason: null,
      }),
    );
    const c = await client(fetch).createCharacter({
      name: "Emily",
      imageUrls: ["https://cdn.higgsfield.ai/a.jpg", "https://cdn.higgsfield.ai/b.jpg"],
    });
    expect(c).toEqual({
      id: CHAR_ID,
      status: "queued",
      thumbnailUrl: null,
      failReason: null,
    });
    expect(seen[0]?.url).toBe(`${BASE}/v1/custom-references`);
    expect(seen[0]?.body).toEqual({
      name: "Emily",
      model_version: "v2",
      input_images: [
        { type: "image_url", image_url: "https://cdn.higgsfield.ai/a.jpg" },
        { type: "image_url", image_url: "https://cdn.higgsfield.ai/b.jpg" },
      ],
    });
  });

  it("sin imágenes no llama", async () => {
    const { fetch, seen } = fake(() => json(200, {}));
    expect(
      await portCode(client(fetch).createCharacter({ name: "E", imageUrls: [] })),
    ).toBe("bad_request");
    expect(seen).toHaveLength(0);
  });

  it("GET /v1/custom-references/{id}: completed y failed con fail_reason saneado", async () => {
    const { fetch, seen } = fake((req) =>
      req.url.endsWith(CHAR_ID)
        ? json(200, {
            id: CHAR_ID,
            name: "Emily",
            status: "failed",
            thumbnail_url: "https://cdn.higgsfield.ai/t.jpg",
            fail_reason: "  No face\n detected  ",
          })
        : json(404, { detail: "Not found" }),
    );
    const c = await client(fetch).getCharacter(CHAR_ID);
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.url).toBe(`${BASE}/v1/custom-references/${CHAR_ID}`);
    expect(c.status).toBe("failed");
    expect(c.failReason).toBe("No face detected");
    expect(c.thumbnailUrl).toBe("https://cdn.higgsfield.ai/t.jpg");
  });

  it("un estado que la doc no lista es una violación de contrato", async () => {
    const { fetch } = fake(() => json(200, { id: CHAR_ID, status: "training" }));
    expect(await portCode(client(fetch).getCharacter(CHAR_ID))).toBe(
      "provider_contract_violation",
    );
  });

  it("un id que no es uuid no arma una URL", async () => {
    const { fetch, seen } = fake(() => json(200, {}));
    expect(await portCode(client(fetch).getCharacter("../requests/x"))).toBe(
      "bad_request",
    );
    expect(seen).toHaveLength(0);
  });

  it("403 = la cuenta sin créditos", async () => {
    const { fetch } = fake(() => json(403, { detail: "Not enough credits" }));
    expect(
      await portCode(
        client(fetch).createCharacter({ name: "E", imageUrls: ["https://x.io/a.jpg"] }),
      ),
    ).toBe("quota_exceeded");
  });
});

describe("HiggsfieldClient — imagen con el personaje (SOUL V2)", () => {
  const REQ = {
    characterId: CHAR_ID,
    prompt: "at the gym, selfie",
    aspectRatio: "9:16" as const,
    n: 4,
  };

  it("el envío y el estimador llevan custom_reference_id y strength 1", async () => {
    const { fetch, seen } = fake((req) =>
      req.url.includes("/estimate/")
        ? json(200, { credits: "0.48", usd: "0.03" })
        : json(200, {
            status: "queued",
            request_id: RID,
            status_url: `${BASE}/requests/${RID}/status`,
            cancel_url: `${BASE}/requests/${RID}/cancel`,
          }),
    );
    const hf = client(fetch);
    const estimate = await hf.estimateCharacterImage(REQ);
    const sub = await hf.generateCharacterImage(REQ);
    const body = {
      prompt: "at the gym, selfie",
      aspect_ratio: "9:16",
      batch_size: 4,
      custom_reference_id: CHAR_ID,
      custom_reference_strength: 1,
    };
    expect(seen[0]?.url).toBe(`${BASE}/estimate/higgsfield-ai/soul/v2/standard`);
    expect(seen[0]?.body).toEqual(body);
    expect(seen[1]?.url).toBe(`${BASE}/higgsfield-ai/soul/v2/standard`);
    expect(seen[1]?.body).toEqual(body);
    expect(estimate.usd).toBe(0.03);
    expect(sub).toEqual({
      kind: "accepted",
      handle: { requestId: RID, statusUrl: `${BASE}/requests/${RID}/status` },
    });
  });

  it("4:5 no está en SOUL V2 y strength 0 falla en el runtime: se rechazan antes", async () => {
    const { fetch, seen } = fake(() => json(200, {}));
    const hf = client(fetch);
    expect(
      await portCode(hf.generateCharacterImage({ ...REQ, aspectRatio: "4:5" })),
    ).toBe("bad_request");
    expect(await portCode(hf.generateCharacterImage({ ...REQ, strength: 0 }))).toBe(
      "bad_request",
    );
    expect(await portCode(hf.generateCharacterImage({ ...REQ, n: 2 }))).toBe(
      "bad_request",
    );
    expect(seen).toHaveLength(0);
  });
});
