import { describe, expect, it } from "vitest";

import {
  linkedInPostAuthor,
  youtubeAuthorUrlFromOEmbed,
  youtubeOEmbedUrl,
} from "./post-link.js";
import { detectBrandSource, type NeedsLookupInput } from "./source-input.js";

function lookup(input: string): NeedsLookupInput {
  const d = detectBrandSource(input);
  if (d.kind !== "needs_lookup") throw new Error(`esperaba needs_lookup, vino ${d.kind}`);
  return d;
}

describe("link a un post → autor · P1-BRAND-005", () => {
  it("LinkedIn /posts/<autor>_…: el slug antes del primer _", () => {
    const d = lookup(
      "https://www.linkedin.com/posts/acme-inc_we-launched-activity-7123-AbCd/",
    );
    expect(linkedInPostAuthor(d.postRef)).toBe("acme-inc");
  });
  it("LinkedIn /feed/update/urn…: no hay autor en la URL", () => {
    const d = lookup("https://www.linkedin.com/feed/update/urn:li:activity:7123/");
    expect(linkedInPostAuthor(d.postRef)).toBeNull();
  });
  it("YouTube: arma la URL del oEmbed público", () => {
    const d = lookup("https://youtu.be/abc123");
    const url = new URL(youtubeOEmbedUrl(d) ?? "");
    expect(url.origin + url.pathname).toBe("https://www.youtube.com/oembed");
    expect(url.searchParams.get("format")).toBe("json");
  });
  it("Instagram /p/…: sin oEmbed (exige token)", () => {
    expect(youtubeOEmbedUrl(lookup("https://instagram.com/p/XYZ/"))).toBeNull();
  });
  it("sólo acepta un author_url de canal de YouTube", () => {
    expect(
      youtubeAuthorUrlFromOEmbed({ author_url: "https://www.youtube.com/@acme" }),
    ).toBe("https://www.youtube.com/@acme");
    expect(
      youtubeAuthorUrlFromOEmbed({ author_url: "https://www.youtube.com/channel/UCx/" }),
    ).toBe("https://www.youtube.com/channel/UCx");
    expect(
      youtubeAuthorUrlFromOEmbed({ author_url: "https://evil.example/@acme" }),
    ).toBeNull();
    expect(
      youtubeAuthorUrlFromOEmbed({ author_url: "https://www.youtube.com/watch?v=1" }),
    ).toBeNull();
    expect(youtubeAuthorUrlFromOEmbed(null)).toBeNull();
  });
});
