/**
 * `YtDlpReferenceReader` con un runner falso: cómo se llama a `yt-dlp` (sin
 * shell, URL detrás de `--`, sin config, sin bajar el video), qué hace con su
 * salida y qué nunca deja salir (el stderr).
 */
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProcessResult, ProcessRunner } from "@fastgram/adapters";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { YtDlpReferenceReader } from "./reference-reader.js";

const URL_OK = "https://www.youtube.com/watch?v=MvV6i0zyDsc";

const result = (over: Partial<ProcessResult>): ProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout: "",
  stdoutBytes: Buffer.alloc(0),
  stderrTail: "",
  timedOut: false,
  stdoutOverflow: false,
  spawnError: null,
  ...over,
});

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "fg-ref-reader-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const publicHost = async () => ["142.250.0.1"];

describe("YtDlpReferenceReader", () => {
  it("una pasada: JSON + miniatura, sin bajar el video, con la URL detrás de --", async () => {
    const calls: { binary: string; args: readonly string[]; env: NodeJS.ProcessEnv }[] =
      [];
    const run: ProcessRunner = async (binary, args, options) => {
      calls.push({ binary, args, env: options.env });
      await writeFile(path.join(dir, "thumb.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
      return result({ stdout: JSON.stringify({ title: "NASA | LOOP Trailer" }) });
    };
    const reader = new YtDlpReferenceReader({
      binary: "/opt/yt-dlp",
      run,
      env: { PATH: "/usr/bin" },
      resolveHost: publicHost,
    });
    const out = await reader.read({
      url: URL_OK,
      directory: dir,
      timeoutMs: 1_000,
      maxThumbnailBytes: 1024,
    });
    expect(out).toEqual({
      ok: true,
      info: { title: "NASA | LOOP Trailer" },
      thumbnail: { body: new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), extension: "jpg" },
    });
    expect(calls).toHaveLength(1);
    const args = calls[0]!.args;
    expect(calls[0]!.binary).toBe("/opt/yt-dlp");
    expect(args).toContain("--no-config");
    expect(args).toContain("--skip-download");
    expect(args).toContain("--dump-single-json");
    expect(args.slice(-2)).toEqual(["--", URL_OK]);
    // Ni una variable del worker en el hijo.
    expect(calls[0]!.env).toEqual({ PATH: "/usr/bin" });
  });

  it("un host que resuelve a la red local no se lanza", async () => {
    let launched = false;
    const reader = new YtDlpReferenceReader({
      run: async () => {
        launched = true;
        return result({});
      },
      resolveHost: async () => ["127.0.0.1"],
    });
    const out = await reader.read({
      url: "https://inside.example.test/x",
      directory: dir,
      timeoutMs: 1_000,
      maxThumbnailBytes: 1024,
    });
    expect(out).toEqual({ ok: false, code: "unsupported_url" });
    expect(launched).toBe(false);
  });

  it("clasifica el stderr en un código y no lo devuelve", async () => {
    const reader = (stderrTail: string, over: Partial<ProcessResult> = {}) =>
      new YtDlpReferenceReader({
        run: async () => result({ exitCode: 1, stderrTail, ...over }),
        resolveHost: publicHost,
      }).read({ url: URL_OK, directory: dir, timeoutMs: 1_000, maxThumbnailBytes: 1 });
    expect(await reader("ERROR: Unsupported URL: https://secret")).toEqual({
      ok: false,
      code: "unsupported_url",
    });
    expect(await reader("ERROR: HTTP Error 503")).toEqual({
      ok: false,
      code: "download_failed",
    });
    expect(await reader("", { exitCode: null, timedOut: true })).toEqual({
      ok: false,
      code: "download_failed",
    });
  });

  it("stdout que no es JSON → download_failed", async () => {
    const out = await new YtDlpReferenceReader({
      run: async () => result({ stdout: "no json" }),
      resolveHost: publicHost,
    }).read({ url: URL_OK, directory: dir, timeoutMs: 1_000, maxThumbnailBytes: 1 });
    expect(out).toEqual({ ok: false, code: "download_failed" });
  });

  it("una miniatura que es un symlink afuera del temporal, o muy grande, se ignora", async () => {
    const outside = await mkdtemp(path.join(tmpdir(), "fg-ref-outside-"));
    try {
      await writeFile(path.join(outside, "secret.jpg"), "x");
      const reader = (prepare: () => Promise<void>, max: number) =>
        new YtDlpReferenceReader({
          run: async () => {
            await prepare();
            return result({ stdout: "{}" });
          },
          resolveHost: publicHost,
        }).read({
          url: URL_OK,
          directory: dir,
          timeoutMs: 1_000,
          maxThumbnailBytes: max,
        });

      const link = await reader(
        () => symlink(path.join(outside, "secret.jpg"), path.join(dir, "thumb.jpg")),
        1024,
      );
      expect(link).toEqual({ ok: true, info: {}, thumbnail: null });

      await rm(path.join(dir, "thumb.jpg"));
      const big = await reader(() => writeFile(path.join(dir, "thumb.jpg"), "12345"), 4);
      expect(big).toEqual({ ok: true, info: {}, thumbnail: null });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
