/**
 * Las dos garantías del runner:
 *  1. código de salida 0 NO significa que ffmpeg escribió algo;
 *  2. el stderr crudo nunca sale hacia afuera.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RenderError } from "../errors.js";
import { probeCapabilities } from "./capabilities.js";
import { assertNonEmptyOutput, classifyStderr, runFfmpeg } from "./run.js";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fastgram-run-"));
});
afterAll(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
});

describe("assertNonEmptyOutput", () => {
  it("falla si el archivo no existe", async () => {
    await expect(
      assertNonEmptyOutput(path.join(dir, "no-existe.mp4")),
    ).rejects.toMatchObject({
      code: "render_empty_output",
    });
  });

  it("falla si el archivo existe pero pesa 0 bytes", async () => {
    const empty = path.join(dir, "vacio.mp4");
    await writeFile(empty, "");
    await expect(assertNonEmptyOutput(empty)).rejects.toMatchObject({
      code: "render_empty_output",
    });
  });

  it("acepta un archivo con contenido y devuelve su tamaño", async () => {
    const full = path.join(dir, "lleno.mp4");
    await writeFile(full, "contenido");
    await expect(assertNonEmptyOutput(full)).resolves.toBe(9);
  });
});

describe("classifyStderr", () => {
  it("traduce el mensaje de la trampa de drawtext a un código estable", () => {
    // Éste es literalmente el texto que escribe ffmpeg cuando falta drawtext.
    expect(classifyStderr("[AVFilterGraph] No such filter: 'drawtext'")).toBe(
      "render_capability_missing",
    );
    expect(classifyStderr("Filter not found")).toBe("render_capability_missing");
  });

  it("traduce entradas corruptas y faltantes", () => {
    expect(classifyStderr("Invalid data found when processing input")).toBe(
      "unsupported_media_format",
    );
    expect(classifyStderr("moov atom not found")).toBe("unsupported_media_format");
    expect(classifyStderr("x.mp4: No such file or directory")).toBe("media_probe_failed");
  });

  it("lo que no reconoce cae en render_failed, no en algo optimista", () => {
    expect(classifyStderr("algo raro pasó")).toBe("render_failed");
    expect(classifyStderr("")).toBe("render_failed");
  });
});

describe("runFfmpeg contra el binario real", () => {
  it("un filtro inexistente da un código estable y no filtra el stderr crudo", async () => {
    const caps = await probeCapabilities();
    if (!caps.available) return;
    const output = path.join(dir, "salida.mp4");
    try {
      await runFfmpeg(
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "lavfi",
          "-i",
          "testsrc=size=64x64:rate=5:duration=1",
          "-vf",
          "unfiltroquenoexiste",
          output,
        ],
        { expectOutput: output, timeoutMs: 30_000 },
      );
      throw new Error("se esperaba un fallo");
    } catch (error) {
      expect(error).toBeInstanceOf(RenderError);
      const rendered = error as RenderError;
      expect(rendered.code).toBe("render_capability_missing");
      // La forma que viaja al cliente no lleva stderr ni rutas locales.
      const wire = JSON.stringify(rendered.toWire());
      expect(wire).not.toContain("unfiltroquenoexiste");
      expect(wire).not.toContain(dir);
    }
  }, 60_000);

  it("una corrida válida deja un archivo con contenido", async () => {
    const caps = await probeCapabilities();
    if (!caps.available) return;
    const output = path.join(dir, "ok.mp4");
    const result = await runFfmpeg(
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc=size=64x64:rate=5:duration=1",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        output,
      ],
      { expectOutput: output, timeoutMs: 60_000 },
    );
    expect(result.outputBytes).toBeGreaterThan(0);
  }, 60_000);
});
