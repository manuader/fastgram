// @vitest-environment node
/**
 * La redirect URI del OAuth (`PU-PUB-002`): reenvía `code` + `state` a la API
 * desde el servidor, con la key y la marca, y vuelve a
 * `/settings/connections` con sólo códigos estables en la URL.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { GET } = await import("./route");

const API_KEY = "fsln_live_test_key_not_a_secret";
const BRAND = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";

/** Un `state` con la forma de `packages/core/src/connections/state.ts` (firma falsa). */
const stateFor = (brand: string) =>
  `v1.${Buffer.from(JSON.stringify({ c: brand, p: "x", n: "n", e: 9e12 })).toString("base64url")}.mac`;

let upstream: ReturnType<typeof vi.fn>;

function respondWith(status: number, body: unknown) {
  upstream = vi.fn(async () => Promise.resolve(Response.json(body, { status })));
  vi.stubGlobal("fetch", upstream);
}

beforeEach(() => {
  vi.stubEnv("FASTGRAM_API_KEY", API_KEY);
  vi.stubEnv("FASTGRAM_API_URL", "http://api.internal:3001/api/v1");
  vi.stubEnv("FASTGRAM_PUBLIC_URL", "");
  vi.stubEnv("FASTGRAM_APP_ORIGIN", "");
  respondWith(200, { data: { kind: "connected", connection: {} } });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function call(url: string, platform: string, cookie?: string) {
  const request = new NextRequest(
    url,
    cookie === undefined ? {} : { headers: { cookie } },
  );
  return GET(request, { params: Promise.resolve({ platform }) });
}

describe("GET /api/fastgram/oauth/[platform]/callback", () => {
  it("reenvía code + state con la key y la marca de la cookie, y redirige con connected", async () => {
    const state = stateFor(BRAND);
    const res = await call(
      `http://localhost:3000/api/fastgram/oauth/x/callback?code=abc&state=${state}`,
      "x",
      `fg_workspace=${BRAND}`,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/settings/connections?connected=x",
    );
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.internal:3001/api/v1/connections/x/callback");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(headers["X-Fastgram-Workspace"]).toBe(BRAND);
    expect(JSON.parse(init.body as string)).toEqual({ state, code: "abc" });
  });

  it("por el túnel (sin cookie): usa la marca del state y vuelve a la app local", async () => {
    vi.stubEnv("FASTGRAM_PUBLIC_URL", "https://fg.example.com");
    const res = await call(
      `https://fg.example.com/api/fastgram/oauth/x/callback?code=abc&state=${stateFor(OTHER)}`,
      "x",
    );
    const headers = (upstream.mock.calls[0] as [string, RequestInit])[1]
      .headers as Record<string, string>;
    expect(headers["X-Fastgram-Workspace"]).toBe(OTHER);
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/settings/connections?connected=x",
    );
  });

  it("error de la API → error con el reason estable, nunca el mensaje", async () => {
    respondWith(400, {
      error: {
        code: "bad_request",
        message: "raw text",
        details: { reason: "oauth_denied" },
      },
    });
    const res = await call(
      `http://localhost:3000/api/fastgram/oauth/tiktok/callback?error=access_denied&state=${stateFor(BRAND)}`,
      "tiktok",
    );
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/settings/connections?error=oauth_denied&platform=tiktok",
    );
  });

  it("Facebook con varias Páginas → select", async () => {
    respondWith(200, { data: { kind: "choose_page", selectionId: "sel-1", pages: [] } });
    const res = await call(
      `http://localhost:3000/api/fastgram/oauth/facebook/callback?code=c&state=${stateFor(BRAND)}`,
      "facebook",
    );
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/settings/connections?select=sel-1",
    );
  });

  it("sin state no llama a la API; plataforma desconocida → 404", async () => {
    const res = await call(
      "http://localhost:3000/api/fastgram/oauth/x/callback?code=c",
      "x",
    );
    expect(res.headers.get("location")).toContain("error=oauth_state_invalid");
    expect(upstream).not.toHaveBeenCalled();
    const nope = await call(
      "http://localhost:3000/api/fastgram/oauth/myspace/callback",
      "myspace",
    );
    expect(nope.status).toBe(404);
  });
});
