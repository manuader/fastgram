/**
 * Las fuentes de `RENDER_FONT_DIR` cargan por nombre **después** de activarlas
 * y **no** antes — con fuentes reales y ffmpeg real.
 *
 * Cada lado corre en un proceso hijo nuevo (`__fixtures__/fontActivationChild.ts`)
 * porque la activación sólo vale antes del primer texto del proceso. Lo único
 * que cambia entre los dos es la activación: es el control que le faltó al
 * experimento de Georgia (trampa 40 del HANDOFF).
 *
 * Se saltea, diciendo por qué, si no hay ffmpeg, si no hay fuentes (no se
 * versionan: `pnpm fonts:fetch <dir>` y `RENDER_TEST_FONT_DIR=<dir>`), o si en
 * macOS este Node no tiene `--experimental-ffi`.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { probeCapabilities } from "../ffmpeg/capabilities.js";

const execFileAsync = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const serviceRoot = path.resolve(here, "../..");
const child = path.join(here, "__fixtures__", "fontActivationChild.ts");

const fontDirRaw = process.env["RENDER_TEST_FONT_DIR"] ?? process.env["RENDER_FONT_DIR"];
const fontDir =
  fontDirRaw === undefined || fontDirRaw === "" ? null : path.resolve(fontDirRaw);
const caps = await probeCapabilities();
const needsFfi = process.platform === "darwin";
const hasFfiFlag = process.allowedNodeEnvironmentFlags.has("--experimental-ffi");

const skipReason = !caps.available
  ? "no hay ffmpeg en el PATH"
  : fontDir === null
    ? "sin fuentes: `pnpm --filter @fastgram/render-service fonts:fetch <dir>` y RENDER_TEST_FONT_DIR=<dir>"
    : !existsSync(path.join(fontDir, "anton-400.ttf"))
      ? `RENDER_TEST_FONT_DIR=${fontDir} no tiene anton-400.ttf`
      : needsFfi && !hasFfiFlag
        ? "macOS necesita node:ffi (--experimental-ffi, Node ≥ 26) y este Node no lo trae"
        : null;

if (skipReason !== null) {
  console.warn(`[fontActivation.integration] salteado: ${skipReason}`);
}
const suite = skipReason === null ? describe : describe.skip;

interface ChildReport {
  readonly mode: string;
  readonly activation: {
    backend: string;
    applied: boolean;
    registered: number;
    reason: string | null;
  } | null;
  readonly anton: { verified: boolean; description: string };
  readonly verified: readonly string[];
  readonly files: number;
  readonly overlaySha: string;
  readonly render:
    | { ok: true; width: number; height: number; warnings: readonly string[] }
    | { ok: false; code: string };
}

let workDir = "";
afterAll(async () => {
  if (workDir !== "") await rm(workDir, { recursive: true, force: true });
});

async function run(mode: "activate" | "control"): Promise<ChildReport> {
  if (workDir === "") workDir = await mkdtemp(path.join(tmpdir(), "fastgram-fontact-"));
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      ...(needsFfi ? ["--experimental-ffi"] : []),
      "--no-warnings",
      "--import",
      "tsx",
      child,
      mode,
      fontDir ?? "",
      workDir,
    ],
    // Sin NODE_OPTIONS heredado: la bandera la decide este test, no el entorno.
    { cwd: serviceRoot, env: { ...process.env, NODE_OPTIONS: "" }, timeout: 120_000 },
  );
  const last = stdout.trim().split("\n").at(-1) ?? "";
  return JSON.parse(last) as ChildReport;
}

suite("activación de RENDER_FONT_DIR, con fuentes y ffmpeg reales", () => {
  it("sin activar, ninguna familia del directorio carga y el render estricto falla", async () => {
    const control = await run("control");
    expect(control.files).toBeGreaterThan(0);
    // La aserción negativa primero (trampa 35): si esto diera verificado, el
    // test de abajo no probaría nada.
    expect(control.anton.verified).toBe(false);
    expect(control.verified).toEqual([]);
    expect(control.render).toEqual({ ok: false, code: "font_unavailable" });
  }, 150_000);

  it("activando, cargan todas las que tienen archivo y el render estricto sale", async () => {
    const control = await run("control");
    const active = await run("activate");

    expect(active.activation?.applied).toBe(true);
    expect(active.anton).toEqual({ verified: true, description: "Anton, 40px" });
    // Todas las que tienen archivo, no «alguna»: la trampa 6 fue justamente
    // que algunas familias resolvían y otras no.
    expect(active.verified).toHaveLength(active.files);

    expect(active.render).toMatchObject({ ok: true, width: 540, height: 960 });
    if (active.render.ok) expect(active.render.warnings).toEqual([]);

    // Lo único que cambió entre los dos procesos es la activación, y el
    // overlay pedido con la MISMA caja es otra imagen.
    expect(active.overlaySha).not.toBe(control.overlaySha);
  }, 300_000);
});
