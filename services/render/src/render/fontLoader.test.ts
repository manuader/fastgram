/**
 * `P2-RENDER-008` — el mecanismo de carga. Lo que se prueba acá es sobre todo
 * que NO haya fallback silencioso: una fuente que no está tiene que doler.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RenderError } from "../errors.js";
import {
  fontAvailability,
  fontLoaderOptionsFromEnv,
  pangoDescription,
  resetFontProbeCache,
  resolveFont,
  verifyFontLoads,
} from "./fontLoader.js";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fastgram-fonts-"));
});
afterAll(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
  resetFontProbeCache();
});

describe("resolveFont", () => {
  it("en modo estricto falla cuando falta el archivo de la fuente", async () => {
    await expect(
      resolveFont("montserrat", 700, 32, { fontDir: dir, strict: true }),
    ).rejects.toMatchObject({ code: "font_unavailable" });
  });

  it("nombra el archivo que hace falta, para que el operador sepa qué copiar", async () => {
    try {
      await resolveFont("bebas", 400, 32, { fontDir: dir, strict: true });
      throw new Error("se esperaba un fallo");
    } catch (error) {
      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).details["expectedFile"]).toContain("bebas-400.ttf");
    }
  });

  it("sin directorio de fuentes y en modo estricto también falla", async () => {
    await expect(
      resolveFont("inter", 400, 32, { fontDir: null, strict: true }),
    ).rejects.toMatchObject({ code: "font_unavailable" });
  });

  it("en modo no estricto degrada pero lo marca: verified === false", async () => {
    const font = await resolveFont("inter", 400, 32, { fontDir: null, strict: false });
    expect(font.verified).toBe(false);
    expect(font.pangoDescription).toBe("Inter, 32px");
  });

  it("las familias de marca sin nombre resuelto fallan en estricto", async () => {
    // `tiktok` y `snapchat` están en `FR-051` pero no tienen archivo conocido.
    await expect(
      resolveFont("tiktok", 500, 32, { fontDir: dir, strict: true }),
    ).rejects.toMatchObject({ code: "font_unavailable" });
  });

  it("un fonts.json puede dar el nombre Pango de una familia de marca", async () => {
    await writeFile(
      path.join(dir, "fonts.json"),
      JSON.stringify({ families: { tiktok: { pangoFamily: "TikTok Display" } } }),
    );
    resetFontProbeCache();
    const font = await resolveFont("tiktok", 500, 32, { fontDir: dir, strict: false });
    expect(font.pangoDescription).toBe("TikTok Display, Medium 32px");
    // Sigue sin verificar porque el archivo tampoco está.
    expect(font.verified).toBe(false);
  });

  it("un fonts.json inválido falla explícito en vez de ignorarse", async () => {
    await writeFile(path.join(dir, "fonts.json"), "{ esto no es json");
    resetFontProbeCache();
    await expect(
      resolveFont("inter", 400, 32, { fontDir: dir, strict: false }),
    ).rejects.toMatchObject({ code: "font_unavailable" });
    await writeFile(path.join(dir, "fonts.json"), "{}");
    resetFontProbeCache();
  });
});

describe("fontLoaderOptionsFromEnv", () => {
  it("el default es estricto", () => {
    expect(fontLoaderOptionsFromEnv({}).strict).toBe(true);
    expect(fontLoaderOptionsFromEnv({}).fontDir).toBeNull();
  });

  it("RENDER_FONT_STRICT=false permite degradar", () => {
    expect(fontLoaderOptionsFromEnv({ RENDER_FONT_STRICT: "false" }).strict).toBe(false);
  });
});

describe("pangoDescription", () => {
  /**
   * La descripción era `"Montserrat 700 42px"`, y Pango lee `"Montserrat 700"`
   * como el NOMBRE de la familia: no la encuentra y cae a la reserva. Medido
   * con Georgia (del sistema): `"Georgia 700"` da el centinela, 517x39.
   */
  it("el peso va como palabra de Pango, nunca como número", () => {
    for (const weight of [300, 500, 600, 700]) {
      expect(pangoDescription("Montserrat", weight, 42)).not.toMatch(/\d{3}/);
    }
    expect(pangoDescription("Montserrat", 300, 42)).toBe("Montserrat, Light 42px");
    expect(pangoDescription("Montserrat", 500, 42)).toBe("Montserrat, Medium 42px");
    expect(pangoDescription("Montserrat", 600, 42)).toBe("Montserrat, Semi-Bold 42px");
    expect(pangoDescription("Montserrat", 700, 42)).toBe("Montserrat, Bold 42px");
  });

  it("400 no lleva palabra", () => {
    expect(pangoDescription("Anton", 400, 40)).toBe("Anton, 40px");
  });

  it("la coma cierra la familia: «Poppins Light» no se parte en Poppins + Light", () => {
    expect(pangoDescription("Poppins Light", 300, 40)).toBe("Poppins Light, Light 40px");
  });
});

describe("verifyFontLoads", () => {
  it("una familia inexistente no verifica, en ningún peso", async () => {
    for (const weight of [400, 700]) {
      expect(await verifyFontLoads("__fastgram_test_missing__", weight)).toBe(false);
    }
  });
});

describe("fontAvailability", () => {
  it("sin directorio, ninguna de las 42 combinaciones figura como disponible", async () => {
    const status = await fontAvailability({ fontDir: null, strict: true });
    expect(status).toHaveLength(42);
    expect(status.filter((s) => s.file || s.verified)).toEqual([]);
  });
});
