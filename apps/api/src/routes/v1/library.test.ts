import type { LibraryAssetRow } from "@fastgram/db";
import { describe, expect, it } from "vitest";

import { toLibraryAsset } from "./library.js";

const license = {
  type: "cc0",
  sourceUrl: "https://commons.wikimedia.org/wiki/File:Arrow_Moving_Graphic.webm",
  licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/",
  verifiedAt: "2026-09-28T12:00:00.000Z",
};

const row: LibraryAssetRow = {
  id: "3eb3ad49-775d-40bd-b5e5-38b105108780",
  title: "Arrow Moving Graphic",
  kind: "green_screen_video",
  mediaType: "video",
  status: "ready",
  provider: "wikimedia",
  externalId: "File:Arrow Moving Graphic.webm",
  storageKey: "library/3eb3ad49-775d-40bd-b5e5-38b105108780/asset.mp4",
  url: "https://storage.test/library/3eb3ad49-775d-40bd-b5e5-38b105108780/asset.mp4",
  previewKey: null,
  previewUrl: null,
  contentType: "video/mp4",
  sizeMb: 0.1,
  durationSec: 8.3,
  width: 1280,
  height: 720,
  license,
  licenseType: "cc0",
  licenseSourceUrl: license.sourceUrl,
  metadata: { schemaVersion: 99 },
  metadataSource: "auto",
  searchText: "Arrow Moving Graphic",
  visibility: "global",
  importedByCompanyId: null,
  failureCode: null,
  createdAt: new Date("2026-09-28T12:00:00.000Z"),
  updatedAt: new Date("2026-09-28T12:00:00.000Z"),
  deletedAt: null,
};

describe("toLibraryAsset", () => {
  it("un JSON guardado que ya no valida sale como null, sin romper la lista", () => {
    const view = toLibraryAsset(row);
    expect(view.metadata).toBeNull();
    expect(view.license.type).toBe("cc0");
    expect(view.createdAt).toBe("2026-09-28T12:00:00.000Z");
  });

  it("nunca expone el id de la marca que lo importó ni la clave del objeto", () => {
    const view = toLibraryAsset({
      ...row,
      importedByCompanyId: "11111111-1111-1111-1111-111111111111",
    }) as unknown as Record<string, unknown>;
    expect(view["importedByCompanyId"]).toBeUndefined();
    expect(view["storageKey"]).toBeUndefined();
  });
});
