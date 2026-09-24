import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPortError } from "@fastgram/ports";

import { FileIntegrationStore } from "../integrations/file-integration-store.js";
import {
  LocalKeyring,
  LocalStateSigner,
  LocalTokenCipher,
  localKeyPath,
} from "./local-keyring.js";
import { createPkcePair, s256Challenge } from "./pkce.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "fastgram-keyring-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("LocalTokenCipher", () => {
  it("ida y vuelta, y el texto cifrado no contiene el token", async () => {
    const cipher = new LocalTokenCipher(
      new LocalKeyring({ path: join(dir, "secret.key") }),
    );
    const token = "IGQVJ-super-secret-token";
    const enc = await cipher.encrypt(token);
    expect(enc).not.toContain(token);
    expect(enc.startsWith("v1.")).toBe(true);
    expect(await cipher.decrypt(enc)).toBe(token);
    // IV aleatorio: dos cifrados del mismo token no son iguales.
    expect(await cipher.encrypt(token)).not.toBe(enc);
  });

  it("crea la clave de 32 bytes con 0600 al primer uso", async () => {
    const path = localKeyPath({ FASTGRAM_HOME: join(dir, "home") });
    await new LocalTokenCipher(new LocalKeyring({ path })).encrypt("x");
    const info = await stat(path);
    expect(info.mode & 0o777).toBe(0o600);
    expect((await readFile(path)).length).toBe(32);
  });

  it("una clave con permisos abiertos se cierra a 0600 al cargarla", async () => {
    const path = join(dir, "secret.key");
    await writeFile(path, Buffer.alloc(32, 7));
    await chmod(path, 0o644);
    await new LocalTokenCipher(new LocalKeyring({ path })).encrypt("x");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("una clave de menos de 32 bytes no se pisa: error y el archivo queda igual", async () => {
    const path = join(dir, "secret.key");
    await writeFile(path, "not-a-key", { mode: 0o600 });
    const cipher = new LocalTokenCipher(new LocalKeyring({ path }));
    await expect(cipher.encrypt("x")).rejects.toSatisfy(
      (e: unknown) => isPortError(e) && e.code === "provider_contract_violation",
    );
    expect(await readFile(path, "utf8")).toBe("not-a-key");
  });

  it("alterado o con otra clave: provider_contract_violation, nunca basura", async () => {
    const a = new LocalTokenCipher(new LocalKeyring({ path: join(dir, "a.key") }));
    const b = new LocalTokenCipher(new LocalKeyring({ path: join(dir, "b.key") }));
    const enc = await a.encrypt("token");
    const parts = enc.split(".");
    const flipped = parts[3]!.startsWith("A")
      ? `B${parts[3]!.slice(1)}`
      : `A${parts[3]!.slice(1)}`;
    const tampered = [parts[0], parts[1], parts[2], flipped].join(".");
    const attempts = [
      () => b.decrypt(enc),
      () => a.decrypt(tampered),
      () => a.decrypt("garbage"),
    ];
    for (const attempt of attempts) {
      await expect(attempt()).rejects.toSatisfy(
        (e: unknown) => isPortError(e) && e.code === "provider_contract_violation",
      );
    }
  });

  it("la firma del state usa una subclave distinta y es estable", async () => {
    const keyring = new LocalKeyring({ path: join(dir, "secret.key") });
    const signer = new LocalStateSigner(keyring);
    expect(await signer.sign("hola")).toBe(await signer.sign("hola"));
    expect(await signer.sign("hola")).not.toBe(await signer.sign("chau"));
  });
});

describe("PKCE", () => {
  it("S256 del vector de RFC 7636 apéndice B", () => {
    expect(s256Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    const pair = createPkcePair();
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("FileIntegrationStore", () => {
  it("ida y vuelta con 0600", async () => {
    const store = new FileIntegrationStore({ path: join(dir, "integrations.json") });
    expect(await store.read()).toEqual({ apps: {} });
    await store.write("x", { clientId: "cid", clientSecret: "sec" });
    await store.write("tiktok", { clientId: "key" });
    expect(await store.read()).toEqual({
      apps: { x: { clientId: "cid", clientSecret: "sec" }, tiktok: { clientId: "key" } },
    });
    expect((await stat(store.path)).mode & 0o777).toBe(0o600);
    await store.write("x", null);
    expect(Object.keys((await store.read()).apps)).toEqual(["tiktok"]);
  });

  it("un archivo corrupto no se pisa", async () => {
    const path = join(dir, "integrations.json");
    await writeFile(path, "{ roto", { mode: 0o600 });
    const store = new FileIntegrationStore({ path });
    await expect(store.write("x", { clientId: "cid" })).rejects.toSatisfy(
      (e: unknown) => isPortError(e) && e.code === "provider_contract_violation",
    );
    expect(await readFile(path, "utf8")).toBe("{ roto");
  });
});
