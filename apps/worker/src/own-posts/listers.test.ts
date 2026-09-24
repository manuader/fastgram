import { describe, expect, it } from "vitest";

import {
  itemsFromFlatPlaylist,
  listInstagramMedia,
  listYouTubeUploads,
  profileListUrl,
} from "./listers.js";

describe("perfil con yt-dlp", () => {
  it("un canal de YouTube sin pestaña pide /shorts; con pestaña, tal cual", () => {
    expect(profileListUrl("https://www.youtube.com/@acme", "youtube")).toBe(
      "https://www.youtube.com/@acme/shorts",
    );
    expect(profileListUrl("https://www.youtube.com/@acme/videos", "youtube")).toBe(
      "https://www.youtube.com/@acme/videos",
    );
    expect(profileListUrl("https://www.tiktok.com/@acme", "tiktok")).toBe(
      "https://www.tiktok.com/@acme",
    );
  });

  it("toma las entradas `url` (forma real de yt-dlp 2026-09) y descarta pestañas", () => {
    const info = {
      _type: "playlist",
      entries: [
        {
          _type: "url",
          ie_key: "Youtube",
          id: "x38jvgefUtI",
          url: "https://www.youtube.com/shorts/x38jvgefUtI",
          title: "a",
        },
        {
          _type: "url",
          ie_key: "YoutubeTab",
          id: "tab",
          url: "https://www.youtube.com/@acme/videos",
        },
        {
          _type: "playlist",
          id: "nested",
          url: "https://www.youtube.com/playlist?list=x",
        },
        {
          _type: "url",
          ie_key: "Youtube",
          id: "Gc4dtEp2fcw",
          url: "https://www.youtube.com/shorts/Gc4dtEp2fcw",
        },
        "basura",
      ],
    };
    const items = itemsFromFlatPlaylist(info, "youtube", 10);
    expect(items.map((i) => i.ref)).toEqual([
      "youtube:x38jvgefUtI",
      "youtube:Gc4dtEp2fcw",
    ]);
    expect(itemsFromFlatPlaylist(info, "youtube", 1)).toHaveLength(1);
    expect(itemsFromFlatPlaylist(null, "youtube", 10)).toEqual([]);
  });
});

describe("APIs oficiales", () => {
  it("Instagram: 401 es connection_unavailable; un carrusel aporta sus hijos", async () => {
    const denied = await listInstagramMedia(
      async () => new Response("{}", { status: 401 }),
      "t",
      5,
    );
    expect(denied).toEqual({ ok: false, code: "connection_unavailable" });

    const ok = await listInstagramMedia(
      async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: "1", media_type: "VIDEO", media_url: "https://cdn/1.mp4" },
              {
                id: "2",
                media_type: "CAROUSEL_ALBUM",
                children: {
                  data: [
                    { id: "3", media_type: "IMAGE", media_url: "https://cdn/3.jpg" },
                    { id: "4", media_type: "IMAGE", media_url: "http://inseguro/4.jpg" },
                  ],
                },
              },
            ],
          }),
        ),
      "t",
      5,
    );
    expect(ok).toEqual({
      ok: true,
      items: [
        { ref: "instagram:1", kind: "video", directUrl: "https://cdn/1.mp4" },
        { ref: "instagram:3", kind: "image", directUrl: "https://cdn/3.jpg" },
      ],
    });
  });

  it("YouTube: uploads → watch URLs; sin canal, lista vacía", async () => {
    const calls: string[] = [];
    const out = await listYouTubeUploads(
      async (url) => {
        calls.push(url);
        if (url.includes("/channels"))
          return new Response(
            JSON.stringify({
              items: [{ contentDetails: { relatedPlaylists: { uploads: "UU123" } } }],
            }),
          );
        return new Response(
          JSON.stringify({ items: [{ contentDetails: { videoId: "abcdefghijk" } }] }),
        );
      },
      "t",
      3,
    );
    expect(out).toEqual({
      ok: true,
      items: [
        {
          ref: "youtube:abcdefghijk",
          kind: "video",
          pageUrl: "https://www.youtube.com/watch?v=abcdefghijk",
        },
      ],
    });
    expect(calls[1]).toContain("playlistId=UU123");
    const none = await listYouTubeUploads(
      async () => new Response(JSON.stringify({ items: [] })),
      "t",
      3,
    );
    expect(none).toEqual({ ok: true, items: [] });
  });
});
