import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";

import { createOAuthCallbackProxy, isOAuthCallbackPath } from "./oauth-callback-proxy.js";

describe("isOAuthCallbackPath", () => {
  it("sólo los cinco callbacks exactos", () => {
    for (const red of ["instagram", "facebook", "threads", "tiktok", "x"]) {
      expect(isOAuthCallbackPath(`/api/fastgram/oauth/${red}/callback`)).toBe(true);
    }
    for (const otro of [
      "/api/fastgram/oauth/linkedin/callback",
      "/api/fastgram/oauth/tiktok/callback/extra",
      "/api/fastgram/v1/content",
      "/api/fastgram/oauth/tiktok/authorize",
      "/settings/connections",
      "/",
    ]) {
      expect(isOAuthCallbackPath(otro), otro).toBe(false);
    }
  });
});

let server: Server | null = null;
afterEach(async () => {
  await new Promise<void>((r) => (server === null ? r() : server.close(() => r())));
  server = null;
});

async function serve(
  proxy: ReturnType<typeof createOAuthCallbackProxy>,
): Promise<string> {
  server = createServer((req, res) => void proxy(req, res));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}

describe("createOAuthCallbackProxy", () => {
  it("reenvía ruta y query a la web, sin headers del cliente, y devuelve status y Location", async () => {
    const seen: { url: string; init: RequestInit | undefined }[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      seen.push({ url: String(input), init });
      return Promise.resolve(
        new Response(null, {
          status: 307,
          headers: {
            location: "http://localhost:3000/settings/connections?connected=tiktok",
          },
        }),
      );
    };
    const base = await serve(
      createOAuthCallbackProxy({ webOrigin: "http://127.0.0.1:3000", fetch: fakeFetch }),
    );

    const res = await fetch(
      `${base}/api/fastgram/oauth/tiktok/callback?code=abc&state=xyz`,
      {
        redirect: "manual",
        headers: { cookie: "fg_workspace=otra", authorization: "Bearer robado" },
      },
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "http://localhost:3000/settings/connections?connected=tiktok",
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe(
      "http://127.0.0.1:3000/api/fastgram/oauth/tiktok/callback?code=abc&state=xyz",
    );
    expect(seen[0]?.init?.headers).toBeUndefined();
  });

  it("cualquier otra ruta o método → 404 sin tocar la web", async () => {
    let calls = 0;
    const fakeFetch: typeof fetch = () => {
      calls++;
      return Promise.resolve(new Response("x"));
    };
    const base = await serve(
      createOAuthCallbackProxy({ webOrigin: "http://127.0.0.1:3000", fetch: fakeFetch }),
    );
    expect((await fetch(`${base}/api/fastgram/v1/content`)).status).toBe(404);
    expect(
      (await fetch(`${base}/api/fastgram/oauth/tiktok/callback`, { method: "POST" }))
        .status,
    ).toBe(404);
    expect(calls).toBe(0);
  });

  it("la web caída → 502", async () => {
    const base = await serve(
      createOAuthCallbackProxy({
        webOrigin: "http://127.0.0.1:3000",
        fetch: () => Promise.reject(new Error("ECONNREFUSED")),
      }),
    );
    expect((await fetch(`${base}/api/fastgram/oauth/x/callback?code=1`)).status).toBe(
      502,
    );
  });
});
