import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProcessResult, ProcessRunner } from "./run-process.js";
import { YtDlpDownloader } from "./yt-dlp-downloader.js";

const result = (over: Partial<ProcessResult> = {}): ProcessResult => ({
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
  dir = await mkdtemp(path.join(tmpdir(), "ytdlp-test-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const publicDns = async (): Promise<readonly string[]> => ["93.184.215.14"];

function scripted(
  info: unknown,
  onDownload: (args: readonly string[]) => Promise<ProcessResult>,
): { run: ProcessRunner; calls: (readonly string[])[] } {
  const calls: (readonly string[])[] = [];
  const run: ProcessRunner = async (_bin, args) => {
    calls.push(args);
    if (args.includes("--dump-single-json")) {
      return result({ stdout: JSON.stringify(info) });
    }
    return onDownload(args);
  };
  return { run, calls };
}

const request = (over: Record<string, unknown> = {}) => ({
  url: "https://example.com/watch?v=1",
  kind: "video" as const,
  directory: dir,
  maxDurationSeconds: 180,
  maxBytes: 50 * 1024 * 1024,
  timeoutMs: 10_000,
  ...over,
});

describe("YtDlpDownloader", () => {
  it("baja: sin shell, --no-config, la URL detrás de -- y la ruta impresa dentro del temporal", async () => {
    const { run, calls } = scripted({ duration: 12, title: "Mi meme 😂" }, async () => {
      await writeFile(path.join(dir, "clip.mp4"), Buffer.from("mp4bytes"));
      return result({ stdout: `${path.join(dir, "clip.mp4")}\n` });
    });
    const d = new YtDlpDownloader({ run, resolveHost: publicDns, env: {} });
    const out = await d.download(request());
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.clip).toMatchObject({
      contentType: "video/mp4",
      extension: "mp4",
      sizeBytes: 8,
      durationSeconds: 12,
      title: "Mi meme 😂",
    });

    const [probe, download] = calls;
    expect(probe).toContain("--no-config");
    // La URL es el último argumento y viene después de `--`.
    expect(probe?.at(-1)).toBe("https://example.com/watch?v=1");
    expect(probe?.at(-2)).toBe("--");
    expect(download).toContain("--load-info-json");
    expect(download).toContain("--no-config");
    expect(download?.[download.indexOf("--max-filesize") + 1]).toBe(
      String(50 * 1024 * 1024),
    );
    expect(download?.[download.indexOf("--match-filters") + 1]).toBe(
      "!is_live & duration <=? 180",
    );
    // La bajada no recibe la URL: usa el JSON medido.
    expect(download).not.toContain("https://example.com/watch?v=1");
  });

  it("una URL que empieza con guion no se lee como opción", async () => {
    const { run, calls } = scripted({}, async () => result({ exitCode: 1 }));
    const d = new YtDlpDownloader({ run, resolveHost: publicDns, env: {} });
    await d.download(request({ url: "https://example.com/--exec=rm" }));
    const probe = calls[0] ?? [];
    expect(probe.indexOf("--")).toBe(probe.length - 2);
  });

  it("too_long antes de bajar si el sitio declara la duración", async () => {
    const { run, calls } = scripted({ duration: 181 }, async () => result());
    const out = await new YtDlpDownloader({
      run,
      resolveHost: publicDns,
      env: {},
    }).download(request());
    expect(out).toEqual({ ok: false, code: "too_long" });
    expect(calls).toHaveLength(1);
  });

  it("too_large antes de bajar si el sitio declara el tamaño", async () => {
    const { run } = scripted(
      { duration: 10, filesize_approx: 60 * 1024 * 1024 },
      async () => result(),
    );
    expect(
      await new YtDlpDownloader({ run, resolveHost: publicDns, env: {} }).download(
        request(),
      ),
    ).toEqual({ ok: false, code: "too_large" });
  });

  it("sale bien sin archivo → lo saltó --max-filesize → too_large", async () => {
    const { run } = scripted({ duration: 10 }, async () => result({ stdout: "" }));
    expect(
      await new YtDlpDownloader({ run, resolveHost: publicDns, env: {} }).download(
        request(),
      ),
    ).toEqual({ ok: false, code: "too_large" });
  });

  it("playlist y live son unsupported_url", async () => {
    for (const info of [
      { _type: "playlist" },
      { is_live: true },
      { live_status: "is_upcoming" },
    ]) {
      const { run } = scripted(info, async () => result());
      expect(
        await new YtDlpDownloader({ run, resolveHost: publicDns, env: {} }).download(
          request(),
        ),
      ).toEqual({ ok: false, code: "unsupported_url" });
    }
  });

  it("clasifica el stderr sin devolverlo", async () => {
    const run: ProcessRunner = async () =>
      result({
        exitCode: 1,
        stderrTail: "ERROR: Unsupported URL: https://example.com/secreto",
      });
    const out = await new YtDlpDownloader({
      run,
      resolveHost: publicDns,
      env: {},
    }).download(request());
    expect(out).toEqual({ ok: false, code: "unsupported_url" });
    expect(JSON.stringify(out)).not.toContain("secreto");

    const other: ProcessRunner = async () =>
      result({
        exitCode: 1,
        stderrTail: "ERROR: [youtube] x: HTTP Error 403: Forbidden",
      });
    expect(
      await new YtDlpDownloader({ run: other, resolveHost: publicDns, env: {} }).download(
        request(),
      ),
    ).toEqual({ ok: false, code: "download_failed" });
  });

  it("timeout y binario ausente son download_failed", async () => {
    for (const r of [
      result({ timedOut: true, exitCode: null }),
      result({ spawnError: "ENOENT" }),
    ]) {
      const run: ProcessRunner = async () => r;
      expect(
        await new YtDlpDownloader({ run, resolveHost: publicDns, env: {} }).download(
          request(),
        ),
      ).toEqual({ ok: false, code: "download_failed" });
    }
  });

  it("un host que resuelve a la red local no llega a lanzar yt-dlp", async () => {
    const calls: unknown[] = [];
    const run: ProcessRunner = async (...a) => {
      calls.push(a);
      return result();
    };
    const d = new YtDlpDownloader({
      run,
      resolveHost: async () => ["127.0.0.1"],
      env: {},
    });
    expect(await d.download(request({ url: "https://127.0.0.1.nip.io/x" }))).toEqual({
      ok: false,
      code: "unsupported_url",
    });
    expect(calls).toHaveLength(0);
  });

  it("no abre un archivo fuera del temporal aunque el stdout lo diga", async () => {
    const { run } = scripted({ duration: 5 }, async () =>
      result({ stdout: "/etc/hosts\n" }),
    );
    expect(
      await new YtDlpDownloader({ run, resolveHost: publicDns, env: {} }).download(
        request(),
      ),
    ).toEqual({ ok: false, code: "too_large" });
  });

  it("audio: pide extraer a m4a y acepta audio/mp4", async () => {
    const { run, calls } = scripted({ duration: 30 }, async () => {
      await writeFile(path.join(dir, "clip.m4a"), Buffer.from("m4a"));
      return result({ stdout: path.join(dir, "clip.m4a") });
    });
    const out = await new YtDlpDownloader({
      run,
      resolveHost: publicDns,
      env: {},
    }).download(request({ kind: "audio" }));
    expect(out.ok && out.clip.contentType).toBe("audio/mp4");
    expect(calls[1]).toEqual(expect.arrayContaining(["-x", "--audio-format", "m4a"]));
  });
});
