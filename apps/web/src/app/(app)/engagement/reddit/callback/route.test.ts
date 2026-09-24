// @vitest-environment node
/**
 * La redirect URI del OAuth de Reddit (`F-190`): reenvía `code` + `state` a
 * la API desde el servidor, con la key y la marca, y vuelve a
 * `/engagement/actions` con sólo códigos estables en la URL.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { GET } = await import("./route");

const API_KEY = "fsln_live_test_key_not_a_secret";
const BRAND = "11111111-1111-4111-8111-111111111111";
const stateFor = (brand: string) =>
  `v1.${Buffer.from(JSON.stringify({ c: brand, p: "reddit", n: "n", e: 9e12 })).toString("base64url")}.mac`;

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
  respondWith(200, { data: { username: "acme_founder" } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("GET /engagement/reddit/callback", () => {
  it("reenvía code + state con la key y la marca del state, y redirige con connected", async () => {
    const state = stateFor(BRAND);
    const res = await GET(
      new NextRequest(
        `http://localhost:3000/engagement/reddit/callback?code=abc&state=${state}`,
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/engagement/actions?reddit=connected&username=acme_founder",
    );
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const [url, init] = upstream.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://api.internal:3001/api/v1/engagement/reddit/callback");
    const headers = init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe(`Bearer ${API_KEY}`);
    expect(headers["X-Fastgram-Workspace"]).toBe(BRAND);
    expect(JSON.parse(String(init.body))).toEqual({ state, code: "abc" });
  });

  it("sin state no llama a la API; un rechazo vuelve con el motivo", async () => {
    const res = await GET(
      new NextRequest("http://localhost:3000/engagement/reddit/callback?code=abc"),
    );
    expect(upstream).not.toHaveBeenCalled();
    expect(res.headers.get("location")).toContain(
      "reddit=error&reason=oauth_state_invalid",
    );

    respondWith(400, {
      error: { code: "bad_request", details: { reason: "oauth_state_wrong_brand" } },
    });
    const res2 = await GET(
      new NextRequest(
        `http://localhost:3000/engagement/reddit/callback?code=abc&state=${stateFor(BRAND)}`,
      ),
    );
    expect(res2.headers.get("location")).toContain("reason=oauth_state_wrong_brand");
  });
});
