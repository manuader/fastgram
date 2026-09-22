/**
 * `P2-RENDER-016` — la versión del motor tiene que servir como clave de cache y
 * tiene que moverse cuando se mueve el resultado.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashCodeTree, listCodeFiles } from "../domain/codeVersion.js";
import { computeCacheKeys } from "../domain/hash.js";
import { buildPayloadSchema } from "../domain/payload.js";
import type { FfmpegCapabilities } from "../ffmpeg/capabilities.js";
import {
  engineVersionFrom,
  hashEngineComponents,
  parseFfmpegVersion,
  type EngineVersionComponents,
} from "./engineVersion.js";

function caps(overrides: Partial<FfmpegCapabilities> = {}): FfmpegCapabilities {
  return {
    available: true,
    version: "ffmpeg version 9.0.1 Copyright (c) 2000-2026 the FFmpeg developers",
    filters: new Set(["overlay"]),
    encoders: new Set(["libx264"]),
    hasDrawtext: false,
    hasOverlay: true,
    hasChromakey: true,
    hasColorkey: true,
    hasZscale: false,
    hasTonemap: true,
    hasColorspace: true,
    ...overrides,
  };
}

describe("token de ffmpeg", () => {
  it("saca la versión del banner y tira el copyright", () => {
    expect(
      parseFfmpegVersion(
        "ffmpeg version 9.0.1 Copyright (c) 2000-2026 the FFmpeg developers",
      ),
    ).toBe("9.0.1");
  });

  it("un build de git conserva su nombre completo", () => {
    expect(parseFfmpegVersion("ffmpeg version N-119584-g1a2b3c4 Copyright (c)")).toBe(
      "N-119584-g1a2b3c4",
    );
  });

  it("una versión distinta da un token distinto", () => {
    expect(parseFfmpegVersion("ffmpeg version 9.0.1 Copyright")).not.toBe(
      parseFfmpegVersion("ffmpeg version 9.0.2 Copyright"),
    );
  });

  /**
   * Lo que rompía la clave de cache: espacios y texto libre. Un banner que no
   * matchea sale hasheado, nunca crudo, y dos banners distintos siguen dando
   * tokens distintos (un `"desconocido"` los fundiría en uno).
   */
  it("un banner raro sale hasheado, no crudo, y sigue separando builds", () => {
    const weird = parseFfmpegVersion("mi-fork custom build (c) alguien");
    expect(weird).not.toContain(" ");
    expect(weird).not.toContain("(c)");
    expect(weird).not.toBe(parseFfmpegVersion("mi-fork otro build (c) alguien"));
  });
});

describe("versión del motor", () => {
  it("es hex y no tiene espacios: se puede concatenar a una clave", () => {
    expect(engineVersionFrom(caps()).version).toMatch(/^[0-9a-f]{64}$/);
  });

  it("la misma máquina y el mismo código dan la misma versión", () => {
    expect(engineVersionFrom(caps()).version).toBe(engineVersionFrom(caps()).version);
  });

  it("un upgrade de ffmpeg la mueve", () => {
    expect(engineVersionFrom(caps()).version).not.toBe(
      engineVersionFrom(caps({ version: "ffmpeg version 9.1.0 Copyright" })).version,
    );
  });

  it("sin ffmpeg no se hereda la versión del que había", () => {
    const sin = engineVersionFrom(caps({ available: false }));
    expect(sin.components.ffmpeg).toBe("unavailable");
    expect(sin.version).not.toBe(engineVersionFrom(caps()).version);
  });

  /**
   * El test que importa de la tarea: **cada componente tiene que mover el
   * hash**. Si alguien saca `code` del material, un cambio en el filtergraph
   * deja de invalidar la cache y nada más se pone rojo.
   */
  it("cada componente, por separado, cambia la versión", () => {
    const base: EngineVersionComponents = {
      code: "c0",
      ffmpeg: "9.0.1",
      sharp: "0.33.5",
      vips: "8.15.3",
      pango: "1.54.0",
      freetype: "2.13.2",
      fonts: "1",
      textStrategy: "sharp-overlay",
    };
    const reference = hashEngineComponents(base);
    for (const key of Object.keys(base) as (keyof EngineVersionComponents)[]) {
      const moved = hashEngineComponents({ ...base, [key]: `${base[key]}-x` });
      expect(moved, `el componente ${key} no mueve la versión`).not.toBe(reference);
    }
    expect(hashEngineComponents(base)).toBe(reference);
  });

  it("publica los componentes para poder contestar «¿por qué cambió?»", () => {
    const { components } = engineVersionFrom(caps());
    expect(components.ffmpeg).toBe("9.0.1");
    expect(components.textStrategy).toBe("sharp-overlay");
    expect(components.code).toMatch(/^[0-9a-f]{64}$/);
    // El stack de texto es lo que decide los píxeles de la tipografía: si esto
    // no viajara, un upgrade de libvips no invalidaría nada.
    expect(components.vips.length).toBeGreaterThan(0);
    expect(components.sharp.length).toBeGreaterThan(0);
  });
});

/**
 * El bucle que cierra todo: si la versión del motor no entrara en las claves,
 * un upgrade cambiaría la etiqueta y el servicio seguiría sirviendo el MP4
 * viejo desde su propia cache. La etiqueta sola no alcanza.
 */
describe("la versión entra en las claves de cache del servicio", () => {
  const payload = buildPayloadSchema.parse({
    type: "wall-of-text",
    canvas: { width: 1080, height: 1920 },
    video: { url: "https://cdn.example.com/media/ws-1/v.mp4" },
    texts: [
      {
        id: "t1",
        text: "hola",
        position: { x: 50, y: 50 },
        widthPercent: 80,
        font: { family: "inter", weight: 400, size: 24 },
      },
    ],
  });

  it("dos versiones de motor distintas no comparten NINGUNA clave", () => {
    const before = computeCacheKeys(payload, "motor-a");
    const after = computeCacheKeys(payload, "motor-b");
    expect(after.mediaKey).not.toBe(before.mediaKey);
    expect(after.overlayKey).not.toBe(before.overlayKey);
    expect(after.buildKey).not.toBe(before.buildKey);
  });

  it("la misma versión sigue dando las mismas claves", () => {
    expect(computeCacheKeys(payload, "motor-a")).toEqual(
      computeCacheKeys(payload, "motor-a"),
    );
  });
});

describe("hash del árbol de código", () => {
  async function tree(): Promise<string> {
    return await mkdtemp(path.join(tmpdir(), "fastgram-codeversion-"));
  }

  it("cambiar una línea de código cambia el hash", async () => {
    const root = await tree();
    try {
      await writeFile(path.join(root, "a.ts"), "export const x = 1;\n");
      const before = hashCodeTree(root);
      await writeFile(path.join(root, "a.ts"), "export const x = 2;\n");
      expect(hashCodeTree(root)).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /**
   * Es lo que hace que no haya nada que acordarse de actualizar: un módulo
   * nuevo entra al hash sin agregarlo a ninguna lista.
   */
  it("un archivo NUEVO cambia el hash sin tocar ninguna lista", async () => {
    const root = await tree();
    try {
      await writeFile(path.join(root, "a.ts"), "export const x = 1;\n");
      const before = hashCodeTree(root);
      await writeFile(path.join(root, "b.ts"), "export const y = 1;\n");
      expect(hashCodeTree(root)).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("mover un archivo sin tocarlo también cambia el hash", async () => {
    const root = await tree();
    try {
      await writeFile(path.join(root, "a.ts"), "export const x = 1;\n");
      const before = hashCodeTree(root);
      await rm(path.join(root, "a.ts"));
      await writeFile(path.join(root, "z.ts"), "export const x = 1;\n");
      expect(hashCodeTree(root)).not.toBe(before);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  /** Si los tests entraran, cada test nuevo re-encodearía el catálogo entero. */
  it("los tests, los .d.ts y los goldens quedan afuera", async () => {
    const root = await tree();
    try {
      await writeFile(path.join(root, "a.ts"), "export const x = 1;\n");
      const before = hashCodeTree(root);
      await writeFile(path.join(root, "a.test.ts"), "it('x', () => {});\n");
      await writeFile(path.join(root, "a.d.ts"), "export declare const x: number;\n");
      await writeFile(path.join(root, "a.js.map"), "{}\n");
      expect(hashCodeTree(root)).toBe(before);
      expect(listCodeFiles(root)).toEqual(["a.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("el orden del filesystem no cambia el resultado", async () => {
    const root = await tree();
    try {
      for (const name of ["z.ts", "a.ts", "m.ts"]) {
        await writeFile(path.join(root, name), `export const ${name[0] ?? "x"} = 1;\n`);
      }
      expect(listCodeFiles(root)).toEqual(["a.ts", "m.ts", "z.ts"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
