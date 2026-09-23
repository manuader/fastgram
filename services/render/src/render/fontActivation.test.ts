/**
 * La activación, sin tocar el motor de texto: plataforma, entorno y CoreText
 * inyectados. Que las fuentes de verdad carguen lo prueba
 * `fontActivation.integration.test.ts`, con fuentes reales y en procesos
 * nuevos.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  activateFontDir,
  noteTextEngineUse,
  renderFontsConf,
  resetFontActivationForTests,
  resetTextEngineUseForTests,
  type CoreTextRegistrar,
} from "./fontActivation.js";

let root = "";
let fontDir = "";

beforeEach(async () => {
  resetFontActivationForTests();
  resetTextEngineUseForTests();
  root = await mkdtemp(path.join(tmpdir(), "fastgram-fontact-unit-"));
  fontDir = path.join(root, "fonts");
  await mkdir(fontDir);
  for (const name of [
    "anton-400.ttf",
    "inter-700.ttf",
    "PROVENANCE.json",
    "LICENCIA-anton.txt",
  ]) {
    await writeFile(path.join(fontDir, name), "x");
  }
});

afterEach(async () => {
  resetFontActivationForTests();
  resetTextEngineUseForTests();
  await rm(root, { recursive: true, force: true });
});

describe("renderFontsConf", () => {
  it("incluye los configs previos sin exigirlos, el directorio y una cache propia", () => {
    const xml = renderFontsConf({
      fontDir: "/f<&>",
      cacheDir: "/c",
      includes: ["/etc/fonts/fonts.conf"],
    });
    expect(xml).toContain(
      '<include ignore_missing="yes">/etc/fonts/fonts.conf</include>',
    );
    expect(xml).toContain("<dir>/f&lt;&amp;&gt;</dir>");
    expect(xml).toContain("<cachedir>/c</cachedir>");
  });
});

describe("activateFontDir", () => {
  it("en Linux genera el fonts.conf y lo deja en FONTCONFIG_FILE", async () => {
    const env: NodeJS.ProcessEnv = {};
    const activation = await activateFontDir(fontDir, {
      platform: "linux",
      env,
      tmpRoot: root,
    });
    expect(activation).toMatchObject({
      backend: "fontconfig",
      applied: true,
      fontFiles: 2,
      reason: null,
    });
    expect(env["FONTCONFIG_FILE"]).toBe(activation.fontconfigFile);
    const xml = await readFile(activation.fontconfigFile ?? "", "utf8");
    expect(xml).toContain(`<dir>${fontDir}</dir>`);
    expect(xml).toContain("/etc/fonts/fonts.conf");
  });

  it("respeta un FONTCONFIG_FILE previo: lo incluye en vez de perderlo", async () => {
    const env: NodeJS.ProcessEnv = { FONTCONFIG_FILE: "/opt/propio/fonts.conf" };
    const activation = await activateFontDir(fontDir, {
      platform: "linux",
      env,
      tmpRoot: root,
    });
    const xml = await readFile(activation.fontconfigFile ?? "", "utf8");
    expect(xml).toContain("/opt/propio/fonts.conf");
    expect(env["FONTCONFIG_FILE"]).not.toBe("/opt/propio/fonts.conf");
  });

  it("en macOS registra cada archivo de fuente en CoreText, y nada más", async () => {
    const seen: string[] = [];
    const registrar: CoreTextRegistrar = {
      register: (file) => {
        seen.push(path.basename(file));
        return true;
      },
    };
    const activation = await activateFontDir(fontDir, {
      platform: "darwin",
      env: {},
      tmpRoot: root,
      loadCoreText: () => registrar,
    });
    expect(seen).toEqual(["anton-400.ttf", "inter-700.ttf"]);
    expect(activation).toMatchObject({
      backend: "coretext",
      applied: true,
      registered: 2,
      reason: null,
    });
  });

  it("en macOS sin node:ffi NO dice que aplicó, y dice cómo arreglarlo", async () => {
    const activation = await activateFontDir(fontDir, {
      platform: "darwin",
      env: {},
      tmpRoot: root,
      loadCoreText: () => null,
    });
    expect(activation.applied).toBe(false);
    expect(activation.registered).toBe(0);
    expect(activation.reason).toContain("--experimental-ffi");
  });

  it("nombra los archivos que CoreText rechazó", async () => {
    const activation = await activateFontDir(fontDir, {
      platform: "darwin",
      env: {},
      tmpRoot: root,
      loadCoreText: () => ({ register: (file) => !file.endsWith("inter-700.ttf") }),
    });
    expect(activation.registered).toBe(1);
    expect(activation.reason).toContain("inter-700.ttf");
  });

  it("sin directorio no aplica nada y lo dice", async () => {
    const env: NodeJS.ProcessEnv = {};
    const activation = await activateFontDir(null, { platform: "linux", env });
    expect(activation.applied).toBe(false);
    expect(activation.reason).toContain("RENDER_FONT_DIR");
    expect(env["FONTCONFIG_FILE"]).toBeUndefined();
  });

  /**
   * Medido: registrar después del primer render deja la familia en el
   * centinela. Activar tarde en silencio sería peor que no activar.
   */
  it("lanza si el motor de texto ya dibujó algo en el proceso", async () => {
    noteTextEngineUse();
    await expect(
      activateFontDir(fontDir, { platform: "linux", env: {}, tmpRoot: root }),
    ).rejects.toThrow(/primer uso/);
  });
});
