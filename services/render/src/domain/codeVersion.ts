/**
 * `P2-RENDER-016` — La versión del código de ESTE servicio, derivada del código
 * mismo.
 *
 * ── El problema que resuelve ─────────────────────────────────────────────────
 * `domain/hash.ts` tenía `ENGINE_VERSION = "1"` con un comentario que decía
 * «cualquier cambio en cómo se arma el filtergraph o el overlay tiene que
 * subirla». Un número escrito a mano con una instrucción de acordarse: mientras
 * nadie se acuerde, un deploy que mueve la tipografía o cambia el layout
 * devuelve artefactos viejos desde la cache y **nada lo dice**. Es exactamente
 * el modo de falla que los golden-file tests de `P2-RENDER-011` existen para
 * detectar, sólo que en producción no hay ningún golden corriendo.
 *
 * Lo mismo del lado del adaptador: `/capabilities` sólo publicaba la versión de
 * FFmpeg, así que un cambio nuestro en el filtergraph o en la composición del
 * overlay no invalidaba **su** cache tampoco.
 *
 * ── La decisión ──────────────────────────────────────────────────────────────
 * La versión se calcula hasheando el árbol de código que este proceso está
 * corriendo. No hay nada que acordarse de subir: si el código cambió, el hash
 * cambió. Un archivo nuevo entra solo, sin agregarlo a ninguna lista.
 *
 * ── Lo que esto cuesta, dicho de frente ──────────────────────────────────────
 * Se hashea **todo** el árbol, no sólo `render/` + `ffmpeg/` + `domain/`. O sea
 * que cambiar un comentario en `config.ts` invalida la cache y se re-encodea.
 * Es caro —el CPU de render es el driver de costo #2 (IMPL §5)— y aun así es la
 * opción correcta, porque las dos fallas no son simétricas:
 *
 *   · invalidar de más cuesta **CPU una vez por deploy**, y se nota en la
 *     factura, que es donde se miran los costos;
 *   · invalidar de menos publica **piezas con el layout equivocado**, para
 *     siempre, sin rastro en ningún log.
 *
 * Y una lista de directorios "que sí deciden el frame" tendría la misma
 * propiedad que el número a mano: alguien tiene que acordarse de actualizarla
 * cuando aparece un directorio nuevo. Justo lo que se está tratando de evitar.
 *
 * ── Qué queda afuera del hash, y por qué ─────────────────────────────────────
 *   · `*.test.ts` / `*.test.js` — un test no cambia lo que se renderiza. Si
 *     entraran, cada test nuevo re-encodearía el catálogo entero.
 *   · `*.d.ts` y `*.map` — no ejecutan.
 *   · `__goldens__/` — son la salida esperada, no el código que la produce.
 *
 * ── Dev y prod dan hashes distintos ──────────────────────────────────────────
 * Con `tsx src/main.ts` se hashea `src/**.ts` y con `node dist/main.js` se
 * hashea `dist/**.js`. Son valores distintos para el mismo commit, y está bien:
 * lo único que se le pide a esta etiqueta es **cambiar cuando cambia el
 * resultado**, no ser igual entre dos formas de ejecutar. Dos procesos del
 * mismo artefacto de build sí dan el mismo hash, que es lo que hace falta para
 * que la cache sirva entre réplicas.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Sólo lo que el runtime ejecuta. */
const CODE_EXTENSIONS = new Set([".ts", ".js", ".mjs", ".cjs", ".mts", ".cts"]);

/** Nada de esto cambia un píxel. Ver el encabezado. */
const IGNORED_DIRECTORIES = new Set(["node_modules", "__goldens__", ".turbo"]);

function isCodeFile(name: string): boolean {
  if (name.endsWith(".d.ts") || name.endsWith(".map")) return false;
  if (/\.test\.[cm]?[jt]s$/.test(name)) return false;
  return CODE_EXTENSIONS.has(path.extname(name));
}

/** Rutas relativas de todo el código bajo `root`, ordenadas. Determinista. */
export function listCodeFiles(root: string): readonly string[] {
  const found: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    // `withFileTypes` evita un `stat` por entrada y, sobre todo, evita seguir
    // symlinks: un symlink a /etc metería medio sistema en el hash.
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        if (IGNORED_DIRECTORIES.has(entry.name)) continue;
        walk(path.join(dir, entry.name), relative);
        continue;
      }
      if (entry.isFile() && isCodeFile(entry.name)) found.push(relative);
    }
  };
  walk(root, "");
  // Orden explícito por código de unidad: `readdir` no promete ninguno, y sin
  // esto el mismo árbol daría hashes distintos según el sistema de archivos.
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Hash del árbol de código bajo `root`. La ruta relativa entra junto al
 * contenido: mover un archivo sin tocarlo también cambia el resultado, porque
 * puede cambiar qué módulo gana en un import.
 */
export function hashCodeTree(root: string): string {
  const digest = createHash("sha256");
  for (const relative of listCodeFiles(root)) {
    digest.update(relative, "utf8");
    digest.update("\0");
    digest.update(readFileSync(path.join(root, relative)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

/**
 * La raíz del código que este proceso corre: el padre del directorio de este
 * módulo (`…/src/domain/codeVersion.ts` → `…/src`).
 */
export function codeRoot(): string {
  return path.dirname(path.dirname(fileURLToPath(import.meta.url)));
}

let cached: string | null = null;

/**
 * Memoizada: el árbol no cambia mientras el proceso vive, y recalcularla por
 * request sería leer ~45 archivos para cada build.
 *
 * Si falla (no se puede leer el propio directorio) el error se propaga y no hay
 * fallback silencioso: un fallback a una constante reintroduciría el bug que
 * esto arregla, y además callado. `main.ts` la fuerza al arrancar para que una
 * instalación rota sea un proceso que no levanta y no un 500 por request.
 */
export function codeVersion(): string {
  cached ??= hashCodeTree(codeRoot());
  return cached;
}

/** Sólo para tests: obliga a recalcular. */
export function resetCodeVersionCache(): void {
  cached = null;
}
