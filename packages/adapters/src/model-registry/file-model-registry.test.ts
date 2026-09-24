import { mkdtemp, readFile, rm, stat, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPortError, type ModelTaskConfig } from "@fastgram/ports";

import {
  FileModelRegistry,
  modelRegistryPath,
  resolveFastgramHome,
} from "./file-model-registry.js";

const ENTRY: ModelTaskConfig = {
  provider: "ollama",
  baseUrl: "http://localhost:11434/v1",
  model: "qwen2.5:7b-instruct",
  contextWindowTokens: 32768,
  updatedAt: "2026-09-24T00:00:00.000Z",
};

let dir: string;
let path: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fastgram-models-"));
  // Un subdirectorio que no existe todavía: el primer `write` tiene que crearlo.
  path = join(dir, "home", "models.json");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("resolveFastgramHome", () => {
  it("FASTGRAM_HOME manda; si no, ~/.fastgram", () => {
    expect(resolveFastgramHome({ FASTGRAM_HOME: "/x/y" })).toBe("/x/y");
    expect(resolveFastgramHome({})).toMatch(/\.fastgram$/);
    expect(modelRegistryPath({ FASTGRAM_HOME: "/x/y" })).toBe("/x/y/models.json");
  });
});

describe("FileModelRegistry", () => {
  it("sin archivo es un registro vacío, no un error", async () => {
    await expect(new FileModelRegistry({ path }).read()).resolves.toEqual({ tasks: {} });
  });

  it("escribe, relee y borra, con permisos 0600", async () => {
    const registry = new FileModelRegistry({ path });
    await registry.write("text", { ...ENTRY, apiKey: "secret-key-123456" });
    await registry.write("judgment", ENTRY);

    const again = await new FileModelRegistry({ path }).read();
    expect(again.tasks.text).toEqual({ ...ENTRY, apiKey: "secret-key-123456" });
    expect(again.tasks.judgment).toEqual(ENTRY);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await stat(join(dir, "home"))).mode & 0o777).toBe(0o700);

    await registry.write("text", null);
    expect((await registry.read()).tasks.text).toBeUndefined();
  });

  it("cierra los permisos de un archivo que alguien abrió a mano", async () => {
    const registry = new FileModelRegistry({ path });
    await registry.write("text", ENTRY);
    await chmod(path, 0o644);
    await registry.write("judgment", ENTRY);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("dos escrituras concurrentes no se pisan", async () => {
    const registry = new FileModelRegistry({ path });
    await Promise.all([
      registry.write("text", ENTRY),
      registry.write("judgment", ENTRY),
      registry.write("vision", ENTRY),
    ]);
    expect(Object.keys((await registry.read()).tasks).sort()).toEqual([
      "judgment",
      "text",
      "vision",
    ]);
  });

  it("un archivo roto es un error y NO se pisa", async () => {
    const registry = new FileModelRegistry({ path });
    await registry.write("text", ENTRY);
    await writeFile(path, "{ not json");
    const error = await registry.read().catch((e: unknown) => e);
    expect(isPortError(error) && error.code).toBe("provider_contract_violation");
    await expect(registry.write("judgment", ENTRY)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("{ not json");
  });

  it("es estricto con la forma y no mete la key en el error", async () => {
    await new FileModelRegistry({ path }).write("text", ENTRY);
    await writeFile(
      path,
      JSON.stringify({
        version: 1,
        tasks: { text: { ...ENTRY, apiKey: "leak-me-please-1234", provider: "nope" } },
      }),
    );
    const error = await new FileModelRegistry({ path }).read().catch((e: unknown) => e);
    expect(isPortError(error) && error.code).toBe("provider_contract_violation");
    expect(JSON.stringify(isPortError(error) ? error.cause : null)).not.toContain(
      "leak-me-please",
    );
  });

  it("rechaza otra versión del archivo", async () => {
    await new FileModelRegistry({ path }).write("text", ENTRY);
    await writeFile(path, JSON.stringify({ version: 2, tasks: {} }));
    await expect(new FileModelRegistry({ path }).read()).rejects.toThrow();
  });
});
