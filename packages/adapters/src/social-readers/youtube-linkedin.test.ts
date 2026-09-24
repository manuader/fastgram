/**
 * YouTube y LinkedIn sin login — sprint 7 (agente G), `P1-BRAND-010/011`.
 *
 * Todo con dobles: un `fetch` que contesta lo que documenta la Data API y un
 * `run` que devuelve la forma de `yt-dlp --flat-playlist --dump-single-json`.
 * Ninguna llamada real.
 */
import { describe, expect, it } from "vitest";
import type { ProcessResult } from "../media-import/run-process.js";

import {
  LinkedInCompanyReader,
  linkedinPageFrom,
  parseLinkedInCompanyPage,
} from "./linkedin-reader.js";
import { YouTubeReader, youtubeChannelFrom } from "./youtube-reader.js";

const UC = "UCabcdefghijklmnopqrstuv";

function ok(json: unknown, status = 200): Response {
  return new Response(JSON.stringify(json), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** `Response` no acepta 999 (fuera de 200–599): un doble con lo que se usa. */
function raw(status: number, body = "", headers: Record<string, string> = {}): Response {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    headers: new Headers(headers),
    arrayBuffer: async () => bytes.buffer,
    text: async () => body,
  } as unknown as Response;
}

function proc(over: Partial<ProcessResult>): ProcessResult {
  return {
    exitCode: 0,
    signal: null,
    stdout: "",
    stdoutBytes: Buffer.alloc(0),
    stderrTail: "",
    timedOut: false,
    stdoutOverflow: false,
    spawnError: null,
    ...over,
  };
}

describe("youtubeChannelFrom", () => {
  it("handle, id y URL vieja", () => {
    expect(youtubeChannelFrom("https://youtube.com/@MiMarca")).toEqual({
      kind: "handle",
      value: "mimarca",
    });
    expect(youtubeChannelFrom("@mimarca")).toEqual({ kind: "handle", value: "mimarca" });
    expect(youtubeChannelFrom(`https://youtube.com/channel/${UC}`)).toEqual({
      kind: "id",
      value: UC,
    });
    expect(youtubeChannelFrom("c/mimarca")).toEqual({
      kind: "legacy",
      path: "c",
      value: "mimarca",
    });
    expect(youtubeChannelFrom("https://evil.com/@mimarca")).toBeNull();
    expect(youtubeChannelFrom("a b")).toBeNull();
  });
});

describe("YouTubeReader · Data API (tier B)", () => {
  it("canal → subidas → estadísticas; la key no aparece en ningún resultado", async () => {
    const urls: string[] = [];
    const reader = new YouTubeReader({
      apiKey: "SECRET-KEY",
      ytDlpBinary: null,
      fetch: async (url) => {
        urls.push(url);
        const u = new URL(url);
        if (u.pathname.endsWith("/channels")) {
          expect(u.searchParams.get("forHandle")).toBe("@mimarca");
          return ok({
            items: [
              {
                snippet: {
                  title: "Mi Marca",
                  customUrl: "@mimarca",
                  description: "Apps para freelancers #productividad",
                  country: "AR",
                  thumbnails: { high: { url: "https://yt3/avatar.jpg" } },
                },
                statistics: { subscriberCount: "1200", hiddenSubscriberCount: false },
                contentDetails: { relatedPlaylists: { uploads: "UUxyz" } },
              },
            ],
          });
        }
        if (u.pathname.endsWith("/playlistItems")) {
          return ok({
            items: [
              {
                snippet: {
                  title: "Viejo",
                  description: "",
                  publishedAt: "2026-09-01T00:00:00Z",
                },
                contentDetails: {
                  videoId: "v1",
                  videoPublishedAt: "2026-09-01T00:00:00Z",
                },
              },
              {
                snippet: { title: "Nuevo #tips", description: "hola @alguien" },
                contentDetails: {
                  videoId: "v2",
                  videoPublishedAt: "2026-09-20T00:00:00Z",
                },
              },
            ],
          });
        }
        return ok({
          items: [
            { id: "v1", statistics: { viewCount: "10", likeCount: "1" } },
            { id: "v2", statistics: { viewCount: "99", commentCount: "3" } },
          ],
        });
      },
    });
    const profile = await reader.readProfile({ handle: "https://youtube.com/@mimarca" });
    expect(profile).toMatchObject({
      status: "ok",
      tier: "B_public_api",
      data: { displayName: "Mi Marca", handle: "mimarca", subscriberCount: 1200 },
    });
    const items = await reader.readRecentContent({ handle: "@mimarca" });
    expect(items.status).toBe("ok");
    if (items.status !== "ok") return;
    expect(items.data.map((i) => i.externalId)).toEqual(["v2", "v1"]);
    expect(items.data[0]).toMatchObject({
      title: "Nuevo #tips",
      hashtags: ["tips"],
      mentions: ["alguien"],
      engagement: { views: 99, comments: 3 },
    });
    // Un solo viaje por análisis (memo) y la key sólo en la query a googleapis.
    expect(urls).toHaveLength(3);
    expect(
      urls.every((u) => u.startsWith("https://www.googleapis.com/youtube/v3/")),
    ).toBe(true);
    expect(JSON.stringify(profile)).not.toContain("SECRET-KEY");
  });

  it("lista vacía = not_found", async () => {
    const reader = new YouTubeReader({
      apiKey: "k",
      ytDlpBinary: null,
      fetch: async () => ok({ items: [] }),
    });
    expect(await reader.readProfile({ handle: "@nadie" })).toMatchObject({
      status: "not_found",
    });
  });

  it("403 de la API sin yt-dlp: quota_exceeded, sin el cuerpo", async () => {
    const reader = new YouTubeReader({
      apiKey: "k",
      ytDlpBinary: null,
      fetch: async () => ok({ error: { message: "key=k invalid" } }, 403),
    });
    await expect(reader.readProfile({ handle: "@x-y" })).rejects.toMatchObject({
      code: "quota_exceeded",
    });
  });
});

describe("YouTubeReader · yt-dlp (tier C)", () => {
  it("sin key usa yt-dlp, sin shell y con la URL después de --", async () => {
    const calls: { binary: string; args: readonly string[] }[] = [];
    const reader = new YouTubeReader({
      ytDlpBinary: "yt-dlp",
      run: async (binary, args) => {
        calls.push({ binary, args });
        return proc({
          stdout: JSON.stringify({
            channel: "Mi Marca",
            uploader_id: "@mimarca",
            description: "Hola",
            channel_follower_count: 50,
            thumbnails: [{ id: "avatar_uncropped", url: "https://yt3/a.jpg" }],
            entries: [
              {
                id: "s1",
                title: "Short",
                url: "https://www.youtube.com/shorts/s1",
                view_count: 7,
              },
              { id: "v1", title: "Video", url: "https://www.youtube.com/watch?v=v1" },
            ],
          }),
        });
      },
    });
    const items = await reader.readRecentContent({
      handle: "https://youtube.com/@mimarca",
    });
    expect(items).toMatchObject({ status: "ok", tier: "C_page_fetch" });
    if (items.status !== "ok") return;
    expect(items.data.map((i) => [i.externalId, i.kind])).toEqual([
      ["s1", "short"],
      ["v1", "video"],
    ]);
    const args = calls[0]?.args ?? [];
    expect(args.at(-2)).toBe("--");
    expect(args.at(-1)).toBe("https://www.youtube.com/@mimarca/videos");
  });

  it("yt-dlp sin instalar = extractor_unavailable; canal inexistente = not_found", async () => {
    const missing = new YouTubeReader({
      run: async () => proc({ spawnError: "ENOENT" }),
    });
    expect(await missing.readProfile({ handle: "@abc" })).toMatchObject({
      status: "extractor_unavailable",
    });
    const gone = new YouTubeReader({
      run: async () =>
        proc({ exitCode: 1, stderrTail: "ERROR: This channel does not exist." }),
    });
    expect(await gone.readProfile({ handle: "@abc" })).toMatchObject({
      status: "not_found",
    });
  });

  it("la API falla y hay yt-dlp: cae a C", async () => {
    const reader = new YouTubeReader({
      apiKey: "k",
      fetch: async () => ok({}, 500),
      run: async () =>
        proc({ stdout: JSON.stringify({ channel: "X", description: "d", entries: [] }) }),
    });
    expect(await reader.readProfile({ handle: "@xyz" })).toMatchObject({
      status: "ok",
      tier: "C_page_fetch",
    });
  });
});

const PAGE = `<!doctype html><html><head>
<meta property="og:title" content="Acme &amp; Co | LinkedIn">
<meta property="og:description" content="We build rockets for everyone.">
<meta property="og:image" content="https://media.licdn.com/logo.png">
<script type="application/ld+json">{"@context":"http://schema.org","@graph":[{"@type":"Organization","name":"Acme & Co","description":"Rockets, but friendly.","url":"https://acme.test","address":{"addressLocality":"Buenos Aires","addressRegion":"CABA"},"numberOfEmployees":{"value":42},"sameAs":["https://x.com/acme","https://www.linkedin.com/company/acme"]}]}</script>
</head><body></body></html>`;

describe("LinkedIn", () => {
  it("linkedinPageFrom", () => {
    expect(linkedinPageFrom("https://linkedin.com/company/Acme")).toEqual({
      kind: "company",
      slug: "acme",
    });
    expect(linkedinPageFrom("company/acme")).toEqual({ kind: "company", slug: "acme" });
    expect(linkedinPageFrom("school/uba")).toEqual({ kind: "school", slug: "uba" });
    expect(linkedinPageFrom("in/persona")).toBeNull();
    expect(linkedinPageFrom("https://evil.com/company/acme")).toBeNull();
  });

  it("parsea JSON-LD y Open Graph", () => {
    expect(parseLinkedInCompanyPage(PAGE)).toEqual({
      displayName: "Acme & Co",
      about: "Rockets, but friendly.",
      headquarters: "Buenos Aires, CABA",
      companySize: "42",
      links: ["https://acme.test", "https://x.com/acme"],
      avatarUrl: "https://media.licdn.com/logo.png",
    });
  });

  it("perfil sí, posts no (partial)", async () => {
    const reader = new LinkedInCompanyReader({
      fetch: async (url) => {
        expect(url).toBe("https://www.linkedin.com/company/acme/");
        return raw(200, PAGE);
      },
    });
    expect(
      await reader.readProfile({ handle: "https://linkedin.com/company/acme" }),
    ).toMatchObject({
      status: "ok",
      tier: "C_page_fetch",
    });
    expect(await reader.readRecentContent({ handle: "company/acme" })).toMatchObject({
      status: "insufficient_content",
    });
  });

  it("999 o authwall = private (el worker degrada a D)", async () => {
    const r999 = new LinkedInCompanyReader({
      fetch: async () => raw(999),
    });
    expect(await r999.readProfile({ handle: "company/acme" })).toMatchObject({
      status: "private",
    });
    const wall = new LinkedInCompanyReader({
      fetch: async () =>
        raw(302, "", { location: "https://www.linkedin.com/authwall?trk=x" }),
    });
    expect(await wall.readProfile({ handle: "company/acme" })).toMatchObject({
      status: "private",
    });
    const gone = new LinkedInCompanyReader({
      fetch: async () => raw(404),
    });
    expect(await gone.readProfile({ handle: "company/acme" })).toMatchObject({
      status: "not_found",
    });
  });
});
