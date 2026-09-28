import { mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPortError } from "@fastgram/ports";

import { JsonFileCollection, JsonFileDocument, withFileLock } from "./json-files.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fastgram-genai-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("JsonFileDocument", () => {
  it("no existe → null; update escribe 0600 y atómico", async () => {
    const doc = new JsonFileDocument(join(dir, "spend.json"));
    expect(await doc.read()).toBeNull();
    const out = await doc.update(() => ({ next: { a: 1 }, result: "ok" }));
    expect(out).toBe("ok");
    expect(await doc.read()).toEqual({ a: 1 });
    expect((await stat(join(dir, "spend.json"))).mode & 0o777).toBe(0o600);
    // Ni temporales ni lock quedan colgados.
    expect(await readdir(dir)).toEqual(["spend.json"]);
  });

  it("cien incrementos concurrentes no pierden ninguno (el lock serializa)", async () => {
    const doc = new JsonFileDocument(join(dir, "n.json"), { lockWaitMs: 25_000 });
    await Promise.all(
      Array.from({ length: 100 }, () =>
        doc.update((cur) => {
          const n =
            typeof cur === "object" && cur !== null ? (cur as { n: number }).n : 0;
          return { next: { n: n + 1 }, result: null };
        }),
      ),
    );
    expect(await doc.read()).toEqual({ n: 100 });
    // 100 vueltas de lock por disco: solo tarda ~1 s, pero bajo `pnpm verify`
    // (turbo con todo en paralelo) pasó los 5 s del default (2026-09-24), y en
    // el sprint 9 el último escritor pasó los 10 s de espera del lock.
  }, 30_000);

  it("un JSON roto no se pisa: provider_contract_violation", async () => {
    await writeFile(join(dir, "bad.json"), "{nope");
    const doc = new JsonFileDocument(join(dir, "bad.json"));
    await expect(doc.read()).rejects.toSatisfy(
      (e: unknown) => isPortError(e) && e.code === "provider_contract_violation",
    );
  });

  it("un lock abandonado (viejo) no bloquea para siempre", async () => {
    const lock = join(dir, "x.lock");
    await writeFile(lock, "123");
    const past = new Date(Date.now() - 60_000);
    const { utimes } = await import("node:fs/promises");
    await utimes(lock, past, past);
    expect(await withFileLock(lock, () => Promise.resolve(7))).toBe(7);
  });
});

describe("JsonFileCollection", () => {
  it("crea, lee, lista y actualiza por scope; otro scope no ve nada", async () => {
    const col = new JsonFileCollection(join(dir, "ai-studio"));
    await col.create("company-a", "gen-1", { id: "gen-1", v: 1 });
    await col.create("company-a", "gen-2", { id: "gen-2", v: 1 });
    expect(await col.get("company-a", "gen-1")).toEqual({ id: "gen-1", v: 1 });
    expect(await col.get("company-b", "gen-1")).toBeNull();
    expect(await col.list("company-b")).toEqual([]);
    expect((await col.list("company-a")).length).toBe(2);
    await col.update("company-a", "gen-1", () => ({
      next: { id: "gen-1", v: 2 },
      result: null,
    }));
    expect(await col.get("company-a", "gen-1")).toEqual({ id: "gen-1", v: 2 });
  });

  it("crear dos veces el mismo id es conflict", async () => {
    const col = new JsonFileCollection(dir);
    await col.create("s", "i", {});
    await expect(col.create("s", "i", {})).rejects.toSatisfy(
      (e: unknown) => isPortError(e) && e.code === "conflict",
    );
  });

  it("ids con separadores o .. se rechazan (no se sale del directorio)", async () => {
    const col = new JsonFileCollection(dir);
    await expect(col.get("../etc", "passwd")).rejects.toSatisfy(
      (e: unknown) => isPortError(e) && e.code === "bad_request",
    );
    await expect(col.get("a", "b/c")).rejects.toSatisfy(
      (e: unknown) => isPortError(e) && e.code === "bad_request",
    );
  });
});
