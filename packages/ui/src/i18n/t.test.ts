import { describe, expect, it } from "vitest";
import { en, type MessageKey } from "./messages.js";
import { createTranslator, interpolate, t } from "./t.js";

describe("interpolate", () => {
  it("sustituye los huecos presentes", () => {
    expect(interpolate("Page {current} of {total}", { current: 1, total: 7 })).toBe(
      "Page 1 of 7",
    );
  });

  it("deja visible el hueco sin valor en vez de vaciarlo", () => {
    expect(interpolate("We couldn't find @{handle}")).toBe("We couldn't find @{handle}");
    expect(interpolate("We couldn't find @{handle}", {})).toBe(
      "We couldn't find @{handle}",
    );
  });

  it("no toca llaves que no son huecos", () => {
    expect(interpolate("{ not a slot }")).toBe("{ not a slot }");
  });
});

describe("t", () => {
  it("resuelve una clave del catálogo en inglés", () => {
    expect(t("common.tryAgain")).toBe("Try again");
  });

  it("interpola sobre el catálogo", () => {
    expect(t("pagination.pageXofY", { current: 3, total: 72 })).toBe("Page 3 of 72");
  });

  it("createTranslator permite otro catálogo con las mismas claves", () => {
    const es = { ...en, "common.tryAgain": "Reintentar" };
    expect(createTranslator(es)("common.tryAgain")).toBe("Reintentar");
  });
});

describe("catálogo en", () => {
  it("no tiene mensajes vacíos", () => {
    for (const [key, value] of Object.entries(en)) {
      expect(value.trim(), `clave vacía: ${key}`).not.toBe("");
    }
  });

  it("fija el copy literal que el PRD §19 y §3.5 especifican", () => {
    // Estos strings son parte de la especificación: si cambian, cambió el PRD.
    const literal: Array<[MessageKey, string]> = [
      [
        "empty.aiStudio.title",
        "No generations yet. Start generating with a prompt below.",
      ],
      ["empty.inspiration.title", "No results"],
      ["empty.inspirationSetup.title", "Inspiration is being set up"],
      ["empty.mediaBank.title", "No images uploaded yet"],
      ["empty.posts.title", "No posts"],
      ["empty.imagePicker.title", "No available images."],
      ["empty.audio.title", "No audio"],
      ["empty.workspaces.title", "No other workspace available"],
      [
        "empty.brandSources.title",
        "No sources yet. Add your website or a social profile so we can learn your brand.",
      ],
      ["common.somethingWentWrong", "Something went wrong"],
      ["common.tryAgainTitleCase", "Try Again"],
      ["error.accessDenied.title", "Access Denied"],
      ["error.leadNotFound.title", "Lead Not Found"],
      ["error.workspaceUnavailable.title", "Workspace Unavailable"],
      ["error.noCompanySelected.title", "No company selected"],
      ["error.blitzQuota.title", "Daily blitz swipe limit reached"],
      ["error.contentQuota.title", "Monthly content quota reached for your plan"],
      ["error.trialQuota.title", "Trial content allowance reached"],
      ["toast.buildingPost", "Building post!"],
      ["toast.contentSaved", "Content saved!"],
      ["toast.postingSoon", "Posting in ~5 minutes!"],
      ["toast.allChangesSaved", "All changes saved"],
      ["toast.viewInLibrary", "View in Library"],
      ["loading.studioGenerating", "Generating your content..."],
      ["loading.analytics", "Loading lifetime post breakdowns"],
    ];
    for (const [key, value] of literal) {
      expect(t(key), key).toBe(value);
    }
  });

  it("los mensajes con hueco lo declaran con la sintaxis {nombre}", () => {
    expect(
      t("error.brand.handleNotFound.title", { handle: "acme", platform: "TikTok" }),
    ).toBe("We couldn't find @acme on TikTok. Check the spelling.");
    expect(t("error.brand.refreshCooldown.title", { hours: 6 })).toBe(
      "You've refreshed this source recently. Try again in 6 hours.",
    );
  });
});
