import { FixedClock, MemoryStorage, canonicalObjectUrl } from "@fastgram/adapters";
import {
  PublicMediaUnavailableError,
  type PublicMediaUrls,
  type SocialPublishCapabilities,
} from "@fastgram/ports";
import { describe, expect, it } from "vitest";

import { createStorageFingerprinter } from "./fingerprint.js";
import {
  bucketBaseOf,
  keyFromCanonicalUrl,
  mediaSourceFor,
  resolveMediaUrls,
} from "./media.js";

const KEY = "content/c1/p1/1/0";

const publicMedia: PublicMediaUrls = {
  forObject: async (key) =>
    `https://tunnel.example/public-media/${encodeURIComponent(key)}`,
};

describe("la clave desde la URL canónica", () => {
  it("MemoryStorage codifica las `/`: se decodifica", async () => {
    const storage = new MemoryStorage(new FixedClock());
    const canonical = await canonicalObjectUrl(storage, KEY);
    expect(keyFromCanonicalUrl(canonical, await bucketBaseOf(storage))).toBe(KEY);
  });

  it("una URL de otro lado no es del bucket", async () => {
    const storage = new MemoryStorage(new FixedClock());
    expect(
      keyFromCanonicalUrl("https://cdn.example.test/x.mp4", await bucketBaseOf(storage)),
    ).toBeNull();
  });
});

describe("qué URL recibe cada plataforma", () => {
  const caps = (over: Partial<SocialPublishCapabilities>) =>
    ({ mediaSource: "public_url", ...over }) as SocialPublishCapabilities;

  it("por defecto pública; TikTok: el video privado, las fotos públicas", () => {
    const tiktok = caps({ mediaSourceByKind: { video: "private_url" } });
    expect(mediaSourceFor(tiktok, "video")).toBe("private_url");
    expect(mediaSourceFor(tiktok, "slideshow")).toBe("public_url");
    expect(mediaSourceFor(caps({ mediaSource: "private_url" }), "video")).toBe(
      "private_url",
    );
  });

  it("pública: pasa por el túnel con la clave; privada: firmada del bucket", async () => {
    const storage = new MemoryStorage(new FixedClock());
    const canonical = await canonicalObjectUrl(storage, KEY);
    expect(
      await resolveMediaUrls({ storage, publicMedia }, [canonical], "public_url"),
    ).toEqual([`https://tunnel.example/public-media/${encodeURIComponent(KEY)}`]);
    const [signed] = await resolveMediaUrls(
      { storage, publicMedia },
      [canonical],
      "private_url",
    );
    expect(signed).toContain("sig=");
  });

  it("sin túnel, el error estable del puerto sube tal cual", async () => {
    const storage = new MemoryStorage(new FixedClock());
    const canonical = await canonicalObjectUrl(storage, KEY);
    const sinTunel: PublicMediaUrls = {
      forObject: async () => {
        throw new PublicMediaUnavailableError();
      },
    };
    await expect(
      resolveMediaUrls({ storage, publicMedia: sinTunel }, [canonical], "public_url"),
    ).rejects.toMatchObject({ code: "public_media_unavailable" });
  });

  it("una URL externa no se expone por el túnel", async () => {
    const storage = new MemoryStorage(new FixedClock());
    await expect(
      resolveMediaUrls(
        { storage, publicMedia },
        ["https://cdn.example.test/x.mp4"],
        "public_url",
      ),
    ).rejects.toMatchObject({ code: "bad_request" });
  });
});

describe("huella del contenido", () => {
  it("mismos bytes → misma huella; distintos → distinta; se cachea por revisión", async () => {
    const storage = new MemoryStorage(new FixedClock());
    const put = async (key: string, text: string) => {
      await storage.put({
        key,
        body: new TextEncoder().encode(text),
        contentType: "video/mp4",
      });
      return canonicalObjectUrl(storage, key);
    };
    const a = await put("content/a/1/0", "igual");
    const b = await put("content/b/1/0", "igual");
    const c = await put("content/c/1/0", "distinto");
    const fp = createStorageFingerprinter(storage);

    const ha = await fp.of({ contentId: "a", revision: 1, files: [a] });
    const hb = await fp.of({ contentId: "b", revision: 1, files: [b] });
    const hc = await fp.of({ contentId: "c", revision: 1, files: [c] });
    expect(ha).toMatch(/^[0-9a-f]{64}$/);
    expect(hb).toBe(ha);
    expect(hc).not.toBe(ha);

    await storage.delete("content/a/1/0");
    // Cacheada: no vuelve a leer el bucket.
    expect(await fp.of({ contentId: "a", revision: 1, files: [a] })).toBe(ha);
  });

  it("un archivo fuera del bucket → sin huella (la regla no se evalúa)", async () => {
    const fp = createStorageFingerprinter(new MemoryStorage(new FixedClock()));
    expect(
      await fp.of({ contentId: "x", revision: 1, files: ["https://afuera/x"] }),
    ).toBeNull();
  });
});
