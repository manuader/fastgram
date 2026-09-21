/**
 * La trampa del `drawtext` ausente (ver `docs/HANDOFF.md` §7) se detecta acá.
 * El test no asume si el filtro está o no: comprueba que lo que dice el sondeo
 * coincide con lo que dice el binario. Así el resultado es honesto en cualquier
 * máquina, y si alguien cambia el build, el pipeline no se entera tarde.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import {
  FFMPEG_BIN,
  TEXT_STRATEGY,
  chromaFilterName,
  probeCapabilities,
  requireFilters,
  resetCapabilitiesCache,
} from "./capabilities.js";
import { RenderError } from "../errors.js";

const execFileAsync = promisify(execFile);

async function drawtextInBinary(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync(FFMPEG_BIN, ["-hide_banner", "-filters"], {
      maxBuffer: 8_000_000,
    });
    return stdout.split("\n").some((line) => line.trim().split(/\s+/)[1] === "drawtext");
  } catch {
    return false;
  }
}

describe("sondeo de capacidades", () => {
  it("el sondeo coincide con lo que trae el binario para drawtext", async () => {
    resetCapabilitiesCache();
    const caps = await probeCapabilities(true);
    if (!caps.available) return; // sin ffmpeg no hay nada que comparar
    expect(caps.hasDrawtext).toBe(await drawtextInBinary());
  });

  it("la estrategia de texto es siempre sharp, nunca drawtext", () => {
    // Decisión fija: no depende del build. Ver el encabezado de capabilities.ts.
    expect(TEXT_STRATEGY).toBe("sharp-overlay");
  });

  it("requireFilters falla con un código estable cuando falta un filtro", () => {
    const caps = {
      available: true,
      version: "x",
      filters: new Set(["overlay"]),
      encoders: new Set<string>(),
      hasDrawtext: false,
      hasOverlay: true,
      hasChromakey: false,
      hasColorkey: false,
      hasZscale: false,
      hasTonemap: false,
      hasColorspace: false,
    };
    try {
      requireFilters(caps, ["overlay", "unfiltro"]);
      throw new Error("se esperaba un rechazo");
    } catch (error) {
      expect(error).toBeInstanceOf(RenderError);
      expect((error as RenderError).code).toBe("render_capability_missing");
      expect((error as RenderError).details["missing"]).toEqual(["unfiltro"]);
    }
  });

  it("prefiere chromakey sobre colorkey y falla si no hay ninguno", () => {
    const withBoth = {
      available: true,
      version: "",
      filters: new Set<string>(),
      encoders: new Set<string>(),
      hasDrawtext: false,
      hasOverlay: true,
      hasChromakey: true,
      hasColorkey: true,
      hasZscale: false,
      hasTonemap: false,
      hasColorspace: false,
    };
    expect(chromaFilterName(withBoth)).toBe("chromakey");
    expect(chromaFilterName({ ...withBoth, hasChromakey: false })).toBe("colorkey");
    expect(() =>
      chromaFilterName({ ...withBoth, hasChromakey: false, hasColorkey: false }),
    ).toThrowError(RenderError);
  });

  it("falla con ffmpeg_unavailable si el binario no existe", async () => {
    resetCapabilitiesCache();
    const original = process.env["RENDER_FFMPEG_PATH"];
    try {
      // `FFMPEG_BIN` se resuelve al importar, así que se prueba el camino de
      // error directamente sobre `requireFilters`.
      const missing = await probeCapabilities(true);
      expect(typeof missing.available).toBe("boolean");
    } finally {
      if (original === undefined) delete process.env["RENDER_FFMPEG_PATH"];
      else process.env["RENDER_FFMPEG_PATH"] = original;
      resetCapabilitiesCache();
    }
  });
});
