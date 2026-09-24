/**
 * Link-in-bio (`INT-018`): un nivel, y un destino que falla no aborta.
 */
import { describe, expect, it } from "vitest";
import { PortError, type SocialReader } from "@fastgram/ports";

import { followLinkInBio } from "./analysis-handler.js";

function reader(
  pages: Record<string, "throw" | "missing" | { bio: string; links?: string[] }>,
) {
  const read: string[] = [];
  const r = {
    capabilities: () => {
      throw new Error("no se usa");
    },
    readRecentContent: () => Promise.reject(new Error("no se sigue nada más")),
    readProfile: ({ handle }: { handle: string }) => {
      read.push(handle);
      const page = pages[handle];
      if (page === "throw") {
        return Promise.reject(new PortError("forbidden", "ssrf", { source: "test" }));
      }
      if (page === "missing" || page === undefined) {
        return Promise.resolve({ status: "not_found" as const });
      }
      return Promise.resolve({
        status: "ok" as const,
        tier: "C_page_fetch" as const,
        data: page,
      });
    },
  } as unknown as SocialReader;
  return { r, read };
}

describe("followLinkInBio", () => {
  it("lee cada destino una vez, sin seguir sus links, y saltea los que fallan", async () => {
    const { r, read } = reader({
      "https://a.com": { bio: "Shop A", links: ["https://deeper.com"] },
      "https://b.com": "throw",
      "https://c.com": "missing",
    });
    const items = await followLinkInBio(r, [
      "https://a.com",
      "https://b.com",
      "https://c.com",
    ]);
    expect(read).toEqual(["https://a.com", "https://b.com", "https://c.com"]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ caption: "Shop A", permalink: "https://a.com" });
  });
});
