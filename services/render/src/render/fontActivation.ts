/**
 * Hace que el motor de texto encuentre **por nombre** las fuentes de
 * `RENDER_FONT_DIR`, sólo para este proceso, sin instalar nada en el sistema.
 *
 * ── Qué decide el nombre, en cada plataforma (medido el 2026-09-23) ──────────
 * El texto lo dibuja sharp (libvips → Pango), **no ffmpeg**: este ffmpeg no
 * trae `drawtext`, ni `subtitles`, ni `ass` (ver `ffmpeg/capabilities.ts`).
 * Así que la pregunta no es qué lee ffmpeg sino qué backend de fuentes tiene
 * el Pango que viene dentro de `@img/sharp-libvips-*`:
 *
 *  - **macOS: CoreText, y nada más.** Con `PANGOCAIRO_BACKEND=fc` Pango
 *    responde literalmente `Available backends are: coretext`. Por eso
 *    `FONTCONFIG_FILE` no cambiaba nada —ni el `fontfile` de sharp, que
 *    registra en fontconfig—: fontconfig lee el directorio (arma su cache)
 *    y Pango nunca le pregunta. Lo que sí funciona es registrar cada archivo
 *    en CoreText con `CTFontManagerRegisterFontsForURL` y alcance **de
 *    proceso** (`kCTFontManagerScopeProcess`): no toca `~/Library/Fonts`, no
 *    sobrevive al proceso, no lo ve ningún otro programa.
 *
 *        centinela __NoSuchFamily__           517x39
 *        Anton  sin registrar                 517x39   ← el centinela
 *        Anton  con FONTCONFIG_FILE           517x39   ← idem
 *        Anton  registrada en CoreText        464x43   ← carga
 *        Bebas Neue / Pacifico registradas    396x32 / 528x57
 *
 *    Desde JS se llama con `node:ffi` (Node ≥ 26 con `--experimental-ffi`; ver
 *    {@link loadCoreText}). Sin la bandera, esto **no** registra nada y lo
 *    dice: las familias no verifican y, en estricto, cada render con texto es
 *    `font_unavailable`, que es lo honesto.
 *
 *  - **Linux: fontconfig.** Ahí Pango usa el backend fc y un `fonts.conf`
 *    propio con `<dir>` apuntando a `RENDER_FONT_DIR` es el mecanismo normal.
 *    **No está verificado en Linux** (esta máquina es macOS y no había imagen
 *    de Node para correrlo en un contenedor): el `fonts.conf` se genera igual,
 *    y el fontLoader lo comprueba con la sonda centinela al arrancar, así que
 *    si no funciona se ve en el log y en `/capabilities`, no en una pieza.
 *
 * El `fonts.conf` se genera en todas las plataformas y `FONTCONFIG_FILE` queda
 * en `process.env`: lo heredan los ffmpeg que se lanzan (`spawn` sin `env`
 * explícito) y cualquier otro consumidor de fontconfig del proceso.
 *
 * ── El orden importa, y es una trampa ────────────────────────────────────────
 * **Esto tiene que correr antes del primer texto que dibuje el proceso.** Las
 * dos cosas se congelan en el primer uso: fontconfig lee `FONTCONFIG_FILE` en
 * su `FcInit`, y el fontmap de CoreText de Pango se arma una vez. Medido:
 * registrar después de un primer render deja Anton en 517x39. Por eso
 * {@link activateFontDir} **lanza** si el motor de texto ya se usó, en vez de
 * activar a medias en silencio.
 */
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

let textEngineUsed = false;

/** Lo llaman los dos lugares que le piden texto a sharp. */
export function noteTextEngineUse(): void {
  textEngineUsed = true;
}

export function hasTextEngineBeenUsed(): boolean {
  return textEngineUsed;
}

/** Sólo para tests que necesitan simular un proceso nuevo. */
export function resetTextEngineUseForTests(): void {
  textEngineUsed = false;
}

export type TextBackend = "coretext" | "fontconfig";

export interface FontActivation {
  readonly fontDir: string | null;
  /** El backend de Pango en esta plataforma: el que decide qué nombre resuelve. */
  readonly backend: TextBackend;
  /**
   * `true` si el mecanismo de ESTE backend se aplicó. No es «las fuentes
   * cargan»: eso lo decide la sonda del fontLoader, que es la única prueba.
   */
  readonly applied: boolean;
  /** Archivos de fuente del directorio (registrados, en CoreText). */
  readonly fontFiles: number;
  readonly registered: number;
  /** El `fonts.conf` generado, o `null` sin directorio. */
  readonly fontconfigFile: string | null;
  /** Por qué no se aplicó, o qué falló. */
  readonly reason: string | null;
}

/** Lo mínimo de `node:ffi` que se usa. La API es experimental: se aísla acá. */
interface NodeFfi {
  dlopen(
    path: string,
    definitions: Record<string, { arguments: string[]; return: string }>,
  ): { functions: Record<string, (...args: unknown[]) => unknown> };
}

export interface CoreTextRegistrar {
  /** Registra un archivo con alcance de proceso. `true` si CoreText lo aceptó. */
  register(file: string): boolean;
}

const CORE_FOUNDATION =
  "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation";
const CORE_TEXT = "/System/Library/Frameworks/CoreText.framework/CoreText";
/** `kCTFontManagerScopeProcess`. */
const SCOPE_PROCESS = 1;

/**
 * `node:ffi` sólo existe con `--experimental-ffi` (verificado en Node 26.8.1;
 * `process.getBuiltinModule` devuelve `undefined` sin la bandera). Se acepta
 * por `NODE_OPTIONS`, así que no hace falta tocar los scripts.
 */
export function loadCoreText(): CoreTextRegistrar | null {
  const getBuiltin = (
    process as unknown as { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule;
  const ffi = getBuiltin?.("node:ffi") as NodeFfi | undefined;
  if (ffi === undefined) return null;
  const cf = ffi.dlopen(CORE_FOUNDATION, {
    // (allocator, bytes, length, isDirectory) → CFURLRef. Los booleanos de C
    // van como uint8: `bool` de ffi rechaza `false` como argumento.
    CFURLCreateFromFileSystemRepresentation: {
      arguments: ["pointer", "string", "int64", "uint8"],
      return: "pointer",
    },
    CFRelease: { arguments: ["pointer"], return: "void" },
  });
  const ct = ffi.dlopen(CORE_TEXT, {
    CTFontManagerRegisterFontsForURL: {
      arguments: ["pointer", "uint32", "pointer"],
      return: "uint8",
    },
  });
  const createUrl = cf.functions["CFURLCreateFromFileSystemRepresentation"];
  const release = cf.functions["CFRelease"];
  const registerUrl = ct.functions["CTFontManagerRegisterFontsForURL"];
  if (createUrl === undefined || release === undefined || registerUrl === undefined) {
    return null;
  }
  return {
    register(file: string): boolean {
      const url = createUrl(0n, file, BigInt(Buffer.byteLength(file)), 0);
      if (url === 0n || url === null || url === undefined) return false;
      try {
        return registerUrl(url, SCOPE_PROCESS, 0n) === 1;
      } finally {
        release(url);
      }
    },
  };
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * El `fonts.conf` propio. Incluye el config previo (el `FONTCONFIG_FILE` que
 * ya hubiera, o el del sistema) con `ignore_missing` para no perder las
 * fuentes base donde las haya, y agrega el directorio. La cache va a un
 * directorio propio: nunca se escribe en la cache del usuario.
 */
export function renderFontsConf(input: {
  readonly fontDir: string;
  readonly cacheDir: string;
  readonly includes: readonly string[];
}): string {
  const includes = input.includes
    .map((file) => `  <include ignore_missing="yes">${xmlEscape(file)}</include>`)
    .join("\n");
  return [
    `<?xml version="1.0"?>`,
    `<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">`,
    `<!-- Generado por services/render al arrancar (fontActivation.ts). No editar. -->`,
    `<fontconfig>`,
    includes,
    `  <dir>${xmlEscape(input.fontDir)}</dir>`,
    `  <cachedir>${xmlEscape(input.cacheDir)}</cachedir>`,
    `</fontconfig>`,
    ``,
  ].join("\n");
}

const SYSTEM_FONTCONFIG_FILES = [
  "/etc/fonts/fonts.conf",
  "/opt/homebrew/etc/fonts/fonts.conf",
  "/usr/local/etc/fonts/fonts.conf",
];

export interface ActivationOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  /** Directorio base del temporal propio. Default: `os.tmpdir()`. */
  readonly tmpRoot?: string;
  /** Inyectable para test. Default: {@link loadCoreText}. */
  readonly loadCoreText?: () => CoreTextRegistrar | null;
}

function fontFilesIn(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => /\.(ttf|otf)$/i.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

let current: FontActivation | null = null;

export function currentFontActivation(): FontActivation | null {
  return current;
}

/**
 * Activa `fontDir` para el proceso. Idempotente por directorio: una segunda
 * llamada con el mismo directorio devuelve la activación ya hecha.
 */
export async function activateFontDir(
  fontDir: string | null,
  options: ActivationOptions = {},
): Promise<FontActivation> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const backend: TextBackend = platform === "darwin" ? "coretext" : "fontconfig";

  if (current !== null && current.fontDir === fontDir) return current;
  if (hasTextEngineBeenUsed()) {
    throw new Error(
      "activateFontDir: el motor de texto ya dibujó algo en este proceso; " +
        "fontconfig y el fontmap de CoreText se congelan en el primer uso y " +
        "activar ahora no tendría efecto. Llamalo al arrancar, antes de todo render.",
    );
  }

  if (fontDir === null) {
    current = {
      fontDir,
      backend,
      applied: false,
      fontFiles: 0,
      registered: 0,
      fontconfigFile: null,
      reason: "RENDER_FONT_DIR no está configurado",
    };
    return current;
  }
  if (!existsSync(fontDir)) {
    current = {
      fontDir,
      backend,
      applied: false,
      fontFiles: 0,
      registered: 0,
      fontconfigFile: null,
      reason: "RENDER_FONT_DIR no existe",
    };
    return current;
  }

  const files = fontFilesIn(fontDir);
  const root = await mkdtemp(path.join(options.tmpRoot ?? tmpdir(), "fastgram-fonts-"));
  const fontconfigFile = path.join(root, "fonts.conf");
  const previous = env["FONTCONFIG_FILE"];
  const includes = [
    ...(previous === undefined || previous === "" ? [] : [previous]),
    ...SYSTEM_FONTCONFIG_FILES.filter((file) => file !== previous),
  ];
  writeFileSync(
    fontconfigFile,
    renderFontsConf({ fontDir, cacheDir: path.join(root, "cache"), includes }),
  );
  env["FONTCONFIG_FILE"] = fontconfigFile;
  // El temporal es del proceso: se va con él.
  if (options.tmpRoot === undefined) {
    process.once("exit", () => {
      rmSync(root, { recursive: true, force: true });
    });
  }

  if (backend === "fontconfig") {
    current = {
      fontDir,
      backend,
      applied: true,
      fontFiles: files.length,
      registered: files.length,
      fontconfigFile,
      reason: null,
    };
    return current;
  }

  const coreText = (options.loadCoreText ?? loadCoreText)();
  if (coreText === null) {
    current = {
      fontDir,
      backend,
      applied: false,
      fontFiles: files.length,
      registered: 0,
      fontconfigFile,
      reason:
        "en macOS el Pango de sharp resuelve familias sólo por CoreText y registrar " +
        "por proceso necesita node:ffi: arrancá con NODE_OPTIONS=--experimental-ffi " +
        "(Node ≥ 26)",
    };
    return current;
  }
  let registered = 0;
  const failed: string[] = [];
  for (const file of files) {
    if (coreText.register(file)) registered += 1;
    else failed.push(path.basename(file));
  }
  current = {
    fontDir,
    backend,
    applied: registered > 0,
    fontFiles: files.length,
    registered,
    fontconfigFile,
    reason:
      failed.length === 0
        ? null
        : `CoreText rechazó ${failed.length}: ${failed.join(", ")}`,
  };
  return current;
}

/** Sólo para tests. */
export function resetFontActivationForTests(): void {
  current = null;
}
