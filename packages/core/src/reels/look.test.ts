import { describe, expect, it } from "vitest";
import type { QueueTransaction } from "@fastgram/ports";

import type { StoredDesignFontFile } from "../design-system/document.js";
import type { DesignSystemTokens, DsFontFamily } from "../design-system/types.js";
import {
  REEL_DEFAULT_LOOK,
  hexLuminance,
  pickLogoForBackground,
  reelLookFromDesignSystem,
} from "./look.js";
import { planReel, reelSpecFromPlan, type ReelPlanAssets } from "./plan.js";
import { acceptReelSuggestionUseCase } from "./accept.js";

/** Un design system con la estructura de FOCUS (M, sprint 9). */
function rotis(licenseConfirmed: boolean): DsFontFamily {
  return {
    name: "Rotis Semi Sans",
    id: "rotis-semi-sans",
    origin: "file",
    category: "sans",
    license: "needs_confirmation",
    licenseConfirmed,
    faces: [
      { weight: 300, style: "normal", file: "fonts/c/rotis-300.otf" },
      { weight: 700, style: "normal", file: "fonts/c/rotis-700.otf" },
      { weight: 800, style: "normal", file: "fonts/c/rotis-800.otf" },
      { weight: 400, style: "italic", file: "fonts/c/rotis-400i.otf" },
    ],
    weights: [300, 400, 700, 800],
    fallback: "inter",
  };
}

function focusTokens(licenseConfirmed: boolean): DesignSystemTokens {
  return {
    colors: [],
    semantic: {
      surfaceDark: "#0A0A0B",
      surfaceLight: "#F6F6F4",
      textOnDark: "#FFFFFF",
      textOnLight: "#0A0A0B",
      accents: ["#FF00FF", "#0033FF", "#00FF33"],
    },
    families: [
      rotis(licenseConfirmed),
      {
        name: "Source Serif 4",
        id: "source-serif-4",
        origin: "google",
        category: "serif",
        license: "open",
        licenseConfirmed: false,
        faces: [],
        weights: [400, 500, 600],
        fallback: "playfair",
      },
    ],
    roles: [
      { role: "display", stack: ["Source Serif 4", "Georgia", "serif"], familyId: "source-serif-4" },
      { role: "body", stack: ["Rotis Semi Sans", "Helvetica Neue", "sans-serif"], familyId: "rotis-semi-sans" },
    ],
    spacing: [],
  };
}

const files: StoredDesignFontFile[] = [300, 700, 800].map((w) => ({
  fileRef: `rotis-${String(w)}`,
  familyId: "rotis-semi-sans",
  weight: w,
  style: "normal",
  storageKey: `fonts/c/rotis-${String(w)}.otf`,
  url: `https://s3.test/bucket/fonts/c/rotis-${String(w)}.otf`,
  contentType: "font/otf",
  bytes: 1000,
}));

const logos = [
  { url: "https://s3.test/bucket/media/c/focus-logo-dark.png", luminance: 0.04 },
  { url: "https://s3.test/bucket/media/c/focus-logo-light.png", luminance: 0.93 },
];

describe("la marca en el reel", () => {
  it("paleta → colores del tema y del texto", () => {
    const look = reelLookFromDesignSystem({
      tokens: focusTokens(true),
      fontFiles: files,
      logos,
      motifs: [],
    });
    expect(look.theme).toEqual({
      background: "#0A0A0B",
      primary: "#F6F6F4",
      accent: "#FF00FF",
      text: "#FFFFFF",
    });
    expect(look.colors.text).toBe("#FFFFFF");
    expect(look.colors.captionActive).toBe("#FF00FF");
    expect(look.colors.beatBox).toBe("#FF00FF");
    // Sobre el magenta contrasta más la tinta oscura que el blanco.
    expect(look.colors.beatText).toBe("#0A0A0B");
    // Sobre el azul del segundo acento, el blanco.
    expect(look.colors.afterLabelText).toBe("#FFFFFF");
  });

  it("licencia tildada → la familia de la marca con su archivo", () => {
    const look = reelLookFromDesignSystem({
      tokens: focusTokens(true),
      fontFiles: files,
      logos: [],
      motifs: [],
    });
    expect(look.fonts.body).toEqual({ family: "brand:rotis-semi-sans", weight: 700, size: 28 });
    expect(look.fonts.caption.family).toBe("brand:rotis-semi-sans");
    // El título es Source Serif 4 (Google, no registrada) → Playfair.
    expect(look.fonts.hook.family).toBe("playfair");
    expect(look.brandFonts.map((f) => `${f.id}@${String(f.weight)}`).sort()).toEqual([
      "rotis-semi-sans@700",
      "rotis-semi-sans@800",
    ]);
    expect(look.brandFonts[0]?.url).toMatch(/^https:\/\/s3\.test\/bucket\/fonts\//);
  });

  it("licencia sin tildar → el reemplazo OFL, sin archivos de marca", () => {
    const look = reelLookFromDesignSystem({
      tokens: focusTokens(false),
      fontFiles: files,
      logos: [],
      motifs: [],
    });
    expect(look.fonts.body).toEqual({ family: "inter", weight: 700, size: 28 });
    expect(look.brandFonts).toEqual([]);
    expect(look.notes).toContain("Rotis Semi Sans: license not confirmed, using inter");
  });

  it("licencia tildada sin archivo subido → reemplazo y nota", () => {
    const look = reelLookFromDesignSystem({
      tokens: focusTokens(true),
      fontFiles: [],
      logos: [],
      motifs: [],
    });
    expect(look.fonts.body.family).toBe("inter");
    expect(look.notes.some((n) => n.includes("no font file"))).toBe(true);
  });

  it("logo por luminancia: claro sobre oscuro, oscuro sobre claro", () => {
    expect(pickLogoForBackground(logos, hexLuminance("#0A0A0B"))?.url).toMatch(/light/);
    expect(pickLogoForBackground(logos, hexLuminance("#F6F6F4"))?.url).toMatch(/dark/);
    expect(pickLogoForBackground(logos, 0.6)?.url).toMatch(/dark/);
    expect(
      pickLogoForBackground([{ url: "a", luminance: null }, { url: "b", luminance: 0.2 }], 0),
    ).toEqual({ url: "b", luminance: 0.2 });
    expect(pickLogoForBackground([], 0)).toBeNull();
    // Un fondo medido claro (una foto de día) manda sobre la superficie oscura.
    const look = reelLookFromDesignSystem({
      tokens: focusTokens(true),
      fontFiles: files,
      logos,
      motifs: [],
      backgroundLuminance: 0.8,
    });
    expect(look.logo?.url).toMatch(/dark/);
    expect(
      reelLookFromDesignSystem({
        tokens: focusTokens(true),
        fontFiles: files,
        logos,
        motifs: [],
        logoEnabled: false,
      }).logo,
    ).toBeNull();
  });
});

describe("el spec con la marca", () => {
  const assets: ReelPlanAssets = {
    backgrounds: [
      { url: "https://s3.test/bucket/media/c/bg1.jpg", kind: "image" },
      { url: "https://s3.test/bucket/media/c/bg2.jpg", kind: "image" },
    ],
    clip: null,
    music: null,
  };

  it("sin design system, el spec es el de siempre (sin logo ni fuentes de marca)", () => {
    const spec = reelSpecFromPlan(
      planReel({ prompt: "Uno. Dos. Tres. Cuatro.", template: "list-beats", assets }),
    );
    expect(spec.brandFonts).toBeUndefined();
    expect(spec.layers.some((l) => l.id === "logo")).toBe(false);
    const hook = spec.layers.find((l) => l.id === "hook");
    expect(hook?.kind === "text" && hook.font).toEqual(
      { ...REEL_DEFAULT_LOOK.fonts.hook, size: 48 },
    );
  });

  it("con la marca: fuentes brand:, sus archivos, logo arriba y motivo", () => {
    const look = reelLookFromDesignSystem({
      tokens: focusTokens(true),
      fontFiles: files,
      logos,
      motifs: [{ url: "https://s3.test/bucket/media/c/rings.png" }],
    });
    const spec = reelSpecFromPlan(
      planReel({
        prompt: "",
        template: "list-beats",
        assets,
        look,
        copy: { hook: "Mirar no alcanza", beats: ["Uno", "Dos", "Tres"], punchline: "Foco" },
        motion: { hook: "kinetic-bounce", captions: "clean" },
      }),
    );
    expect(spec.theme.accent).toBe("#FF00FF");
    const beat = spec.layers.find((l) => l.id === "beat-1");
    expect(beat?.kind === "text" && beat.font.family).toBe("brand:rotis-semi-sans");
    expect(beat?.kind === "text" && beat.background?.color).toBe("#FF00FF");
    // Sólo las caras que alguna capa usa.
    expect(spec.brandFonts?.map((f) => f.weight)).toEqual([700]);
    const logo = spec.layers.find((l) => l.id === "logo");
    expect(logo?.kind === "image" && logo.url).toMatch(/light/);
    expect(logo?.z).toBe(30);
    expect(spec.layers.some((l) => l.id === "motif")).toBe(true);
    const hook = spec.layers.find((l) => l.id === "hook");
    expect(hook?.kind === "text" && hook.animation).toBe("kinetic-bounce");
  });

  it("con logo, el gancho de la reacción baja para no pisarlo", () => {
    const look = reelLookFromDesignSystem({
      tokens: focusTokens(true),
      fontFiles: files,
      logos,
      motifs: [],
    });
    const spec = reelSpecFromPlan(
      planReel({
        prompt: "Gancho. Remate.",
        template: "hook-reaction-punchline",
        assets: {
          ...assets,
          clip: { url: "https://s3.test/bucket/media/c/gs.mp4", chroma: "green" },
        },
        look,
      }),
    );
    const hook = spec.layers.find((l) => l.id === "hook");
    expect(hook?.kind === "text" && hook.position.y).toBe(17);
    const captions = spec.layers.find((l) => l.kind === "captions");
    expect(captions?.kind === "captions" && captions.activeColor).toBe("#FF00FF");
  });
});

describe("aceptar un reel", () => {
  const tx = { tx: 1 } as unknown as QueueTransaction;
  const ledger = {
    saves: {
      plan: "pro" as const,
      includedUsed: 0,
      purchasedRemaining: 0,
      overageUsed: 0,
      overageEnabled: false,
      resetAt: new Date("2026-10-28T00:00:00Z"),
    },
    swipes: { used: 0, limit: null, resetAt: new Date("2026-09-29T00:00:00Z") },
  };

  it("cobra, crea la pieza reel, marca popped y encola el build, en ese orden", async () => {
    const calls: string[] = [];
    const out = await acceptReelSuggestionUseCase(
      {
        clock: { now: () => new Date(0), nowMs: () => 0 } as never,
        ids: { newId: () => "cnt-1" },
        queue: {
          enqueue: async (req: { queue: string; payload: unknown }) => {
            calls.push(`enqueue:${req.queue}`);
            return { id: "job-1", created: true };
          },
        } as never,
        repository: {
          loadQuota: async () => {
            calls.push("loadQuota");
            return ledger as never;
          },
          saveQuota: async () => {
            calls.push("saveQuota");
          },
          insertContent: async (c) => {
            calls.push(`insert:${c.type}:${c.status}`);
          },
          markSuggestionPopped: async () => {
            calls.push("popped");
          },
        },
      },
      {
        companyId: "c1",
        suggestion: {
          id: "s1",
          companyId: "c1",
          status: "queued",
          generatedText: "Mirar no alcanza",
          angleId: null,
        },
        transaction: tx,
      },
    );
    expect(calls).toEqual([
      "loadQuota",
      "insert:reel:BUILDING",
      "saveQuota",
      "popped",
      "enqueue:content-build",
    ]);
    expect(out.content.type).toBe("reel");
  });

  it("una sugerencia que ya no está en cola no cobra nada", async () => {
    await expect(
      acceptReelSuggestionUseCase(
        {
          clock: {} as never,
          ids: { newId: () => "x" },
          queue: {} as never,
          repository: {} as never,
        },
        {
          companyId: "c1",
          suggestion: {
            id: "s1",
            companyId: "c1",
            status: "popped",
            generatedText: null,
            angleId: null,
          },
          transaction: tx,
        },
      ),
    ).rejects.toMatchObject({ code: "invalid_state" });
  });
});
