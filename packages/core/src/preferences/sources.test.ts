import { describe, expect, it } from "vitest";

import {
  isLibraryCopyLocation,
  prefMediaSourceOf,
  prefMusicSourceOf,
} from "./sources.js";

const CID = "0b9a8c9e-6f0e-4d7c-9a51-3f1e2d4c5b61";

describe("fuente de una media en el vocabulario de preferencias", () => {
  it("el origen de la fila, y una copia de la biblioteca es `library` aunque diga `manual_upload`", () => {
    expect(prefMediaSourceOf({ origin: "manual_upload" })).toBe("upload");
    expect(prefMediaSourceOf({ origin: "brand_kit" })).toBe("brand");
    expect(
      prefMediaSourceOf({
        origin: "manual_upload",
        location: `http://localhost:9000/fastgram/media/${CID}/library/x.mp4`,
      }),
    ).toBe("library");
    expect(
      prefMediaSourceOf({
        origin: "manual_upload",
        location: `memory://bucket/media%2F${CID}%2Flibrary%2Fx.mp4`,
      }),
    ).toBe("library");
    expect(prefMediaSourceOf({ origin: "rarísimo" })).toBeNull();
  });

  it("música: la pista importada desde la biblioteca es `library`", () => {
    expect(prefMusicSourceOf({ origin: "upload" })).toBe("upload");
    expect(
      prefMusicSourceOf({ origin: "import", location: `audio/${CID}/library/a.mp3` }),
    ).toBe("library");
  });

  it("sólo la carpeta `library` de una marca, no cualquier `library` en la URL", () => {
    expect(isLibraryCopyLocation(`media/${CID}/uploads/library.mp4`)).toBe(false);
    expect(isLibraryCopyLocation("library/abc/clip.mp4")).toBe(false);
    expect(isLibraryCopyLocation(null)).toBe(false);
  });
});
