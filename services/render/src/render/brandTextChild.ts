/**
 * Proceso hijo que dibuja texto con **fuentes de marca** — sprint 9 (M).
 *
 * Por qué un proceso aparte: el fontmap de CoreText de Pango (y el `FcInit`
 * de fontconfig) se congelan en el primer texto del proceso; el render
 * principal ya dibujó las 12 familias al arrancar, así que una fuente que
 * llega en un request ya no se puede registrar ahí (medido: firma del
 * centinela). Acá el proceso es nuevo: registra y **después** dibuja.
 *
 * Autocontenido a propósito: sólo `node:*` y `sharp`, sin imports relativos.
 * Así corre igual como `.ts` (Node ≥ 23.6 saca los tipos solo, en desarrollo
 * y en vitest) y como `.js` compilado en `dist/`. Por eso repite, en chico, el
 * registro por CoreText de `fontActivation.ts` en vez de importarlo.
 *
 * Protocolo: un JSON por stdin, un JSON por stdout.
 *
 *   in:  { fonts: string[], jobs: {text, font, width, align}[],
 *          probe: {family, weightWord, styleWord} | null }
 *   out: { registered, verified, results: {png, width, height}[] }
 *
 * En Linux no registra nada: el padre le pasa `FONTCONFIG_FILE` con un
 * `fonts.conf` que incluye la carpeta de las fuentes (sin verificar en Linux,
 * igual que `fontActivation.ts`; la sonda lo dice).
 */
import { createHash } from "node:crypto";
import sharp from "sharp";

interface Job {
  readonly text: string;
  readonly font: string;
  readonly width: number;
  readonly align: "left" | "centre" | "right";
}

interface Input {
  readonly fonts: readonly string[];
  readonly jobs: readonly Job[];
  readonly probe: {
    readonly family: string;
    readonly weightWord: string;
    readonly styleWord: string;
  } | null;
}

interface NodeFfi {
  dlopen(
    path: string,
    definitions: Record<string, { arguments: string[]; return: string }>,
  ): { functions: Record<string, (...args: unknown[]) => unknown> };
}

const PROBE = "MWiljq1080 Hamburgefonstiv";
const SENTINEL = "__fastgram_no_such_family__";

function registerCoreText(files: readonly string[]): number {
  const getBuiltin = (
    process as unknown as { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule;
  const ffi = getBuiltin?.("node:ffi") as NodeFfi | undefined;
  if (ffi === undefined) return 0;
  const cf = ffi.dlopen(
    "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation",
    {
      CFURLCreateFromFileSystemRepresentation: {
        arguments: ["pointer", "string", "int64", "uint8"],
        return: "pointer",
      },
      CFRelease: { arguments: ["pointer"], return: "void" },
    },
  );
  const ct = ffi.dlopen("/System/Library/Frameworks/CoreText.framework/CoreText", {
    CTFontManagerRegisterFontsForURL: {
      arguments: ["pointer", "uint32", "pointer"],
      return: "uint8",
    },
  });
  const createUrl = cf.functions["CFURLCreateFromFileSystemRepresentation"];
  const release = cf.functions["CFRelease"];
  const register = ct.functions["CTFontManagerRegisterFontsForURL"];
  if (createUrl === undefined || release === undefined || register === undefined)
    return 0;
  let ok = 0;
  for (const file of files) {
    const url = createUrl(0n, file, BigInt(Buffer.byteLength(file)), 0);
    if (url === 0n || url === null || url === undefined) continue;
    try {
      // 1 = kCTFontManagerScopeProcess: no toca el sistema, muere con el hijo.
      if (register(url, 1, 0n) === 1) ok += 1;
    } finally {
      release(url);
    }
  }
  return ok;
}

async function signature(font: string): Promise<string> {
  const { data, info } = await sharp({ text: { text: PROBE, font, rgba: true, dpi: 72 } })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return createHash("sha256")
    .update(`${String(info.width)}x${String(info.height)}:`)
    .update(data)
    .digest("hex");
}

function describe(family: string, weightWord: string, styleWord: string): string {
  const words = [weightWord, styleWord].filter((w) => w !== "").join(" ");
  return words === "" ? `${family}, 40px` : `${family}, ${words} 40px`;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

const input = JSON.parse(await readStdin()) as Input;
const registered =
  process.platform === "darwin" ? registerCoreText(input.fonts) : input.fonts.length;

let verified = false;
if (input.probe !== null) {
  const { family, weightWord, styleWord } = input.probe;
  const own = await signature(describe(family, weightWord, styleWord));
  const sentinel = await signature(describe(SENTINEL, weightWord, styleWord));
  verified = own !== sentinel;
}

const results: { png: string; width: number; height: number }[] = [];
for (const job of input.jobs) {
  const { data, info } = await sharp({
    text: {
      text: job.text,
      font: job.font,
      rgba: true,
      dpi: 72,
      width: job.width,
      align: job.align,
      wrap: "word",
    },
  })
    .png()
    .toBuffer({ resolveWithObject: true });
  results.push({ png: data.toString("base64"), width: info.width, height: info.height });
}

process.stdout.write(`${JSON.stringify({ registered, verified, results })}\n`);
