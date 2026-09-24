/**
 * Lo puro del adaptador de ComfyUI: inyectar el pedido en el workflow y leer
 * las salidas de `/history` — `PU-LATER-003`.
 *
 * Fuentes (verificadas el 2026-09-24):
 *
 * - Rutas: https://docs.comfy.org/development/comfyui-server/comms_routes
 *   (`POST /prompt` «submit a prompt to the queue», `GET /history/{prompt_id}`,
 *   `GET /view`, `POST /upload/image`, `GET /system_stats`).
 * - Forma del workflow y de las salidas: el ejemplo oficial
 *   `script_examples/websockets_api_example.py` del repo de ComfyUI —
 *   `{"prompt": prompt, "client_id": …}` al encolar;
 *   `history[prompt_id]['outputs'][node_id]['images']` con
 *   `filename`/`subfolder`/`type`, que se piden a `/view` con esos tres
 *   parámetros.
 * - Estado de una entrada del historial: `execution.py` (`PromptQueue.task_done`):
 *   `{ prompt, outputs, status: { status_str: 'success' | 'error', completed,
 *   messages } }`.
 */
import type {
  ComfyInputRef,
  ComfyWorkflowConfig,
  GenAspectRatio,
  GenMediaKind,
} from "@fastgram/ports";

/** Lo que se escribe en el workflow para un pedido. */
export interface ComfyInjection {
  readonly prompt: string;
  /** Sólo si el workflow tiene `width`/`height` marcados. */
  readonly size?: { readonly width: number; readonly height: number };
  /** Sólo si tiene `seed` marcado. */
  readonly seed?: number;
  /** El nombre que devolvió `POST /upload/image`, si tiene `image` marcado. */
  readonly imageName?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Qué nodo o input falta para inyectar. `null` = se puede. La validación de
 * `core` lo revisó al guardar; esto cubre un `models.json` editado a mano.
 */
export function missingRef(
  workflow: Readonly<Record<string, unknown>>,
  ref: ComfyInputRef,
): string | null {
  const node = workflow[ref.nodeId];
  if (!isRecord(node) || !isRecord(node["inputs"])) {
    return `The workflow has no node ${ref.nodeId}`;
  }
  if (!Object.hasOwn(node["inputs"], ref.input)) {
    return `Node ${ref.nodeId} has no input "${ref.input}"`;
  }
  return null;
}

/**
 * Una copia del workflow con el pedido escrito en los inputs marcados. El
 * original (el del registro) no se toca: un pedido no puede ensuciar al
 * siguiente.
 */
export function injectWorkflow(
  config: ComfyWorkflowConfig,
  injection: ComfyInjection,
): Record<string, unknown> {
  const workflow = structuredClone(config.workflow) as Record<string, unknown>;
  const set = (ref: ComfyInputRef | undefined, value: string | number | undefined) => {
    if (ref === undefined || value === undefined) return;
    const node = workflow[ref.nodeId];
    if (!isRecord(node) || !isRecord(node["inputs"])) return;
    node["inputs"][ref.input] = value;
  };
  set(config.prompt, injection.prompt);
  set(config.width, injection.size?.width);
  set(config.height, injection.size?.height);
  set(config.seed, injection.seed);
  set(config.image, injection.imageName);
  return workflow;
}

/** Múltiplo al que se redondea el tamaño. Una elección nuestra: ver abajo. */
const SIZE_STEP = 16;
const MIN_SIDE = 64;

const RATIOS: Readonly<Record<GenAspectRatio, readonly [number, number]>> = {
  "1:1": [1, 1],
  "4:5": [4, 5],
  "3:4": [3, 4],
  "4:3": [4, 3],
  "9:16": [9, 16],
  "16:9": [16, 9],
};

/**
 * El tamaño para una relación, **conservando el área del workflow**: un
 * workflow de SD 1.5 a 512×512 sigue en ~0,26 MP y uno de SDXL a 1024×1024 en
 * ~1 MP, que es la resolución para la que cada modelo se entrenó. Redondeado a
 * múltiplos de 16 (latentes de SD: /8; varios modelos de video piden /16).
 * Es una decisión nuestra, no un dato de ComfyUI.
 */
export function sizeForAspect(
  ratio: GenAspectRatio,
  original: { readonly width: number; readonly height: number },
): { width: number; height: number } {
  const [a, b] = RATIOS[ratio];
  const area = Math.max(original.width * original.height, MIN_SIDE * MIN_SIDE);
  const width = Math.sqrt((area * a) / b);
  const height = (width * b) / a;
  const round = (v: number) => Math.max(MIN_SIDE, Math.round(v / SIZE_STEP) * SIZE_STEP);
  return { width: round(width), height: round(height) };
}

/** El número guardado en un input, o `null` si no es un número. */
export function numberInput(
  workflow: Readonly<Record<string, unknown>>,
  ref: ComfyInputRef,
): number | null {
  const node = workflow[ref.nodeId];
  if (!isRecord(node) || !isRecord(node["inputs"])) return null;
  const value = node["inputs"][ref.input];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/* ------------------------------------------------------------------------ *
 * Salidas
 * ------------------------------------------------------------------------ */

/** Un archivo que ComfyUI guardó: lo que `/view` pide para servirlo. */
export interface ComfyFile {
  readonly filename: string;
  readonly subfolder: string;
  /** `output` (nodos Save…) o `temp` (Preview…). */
  readonly type: string;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

/** El tipo por la extensión, o `null` si no es algo que FastGram guarde. */
export function contentTypeOf(filename: string): string | null {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return CONTENT_TYPES[ext] ?? null;
}

/**
 * Todos los archivos de `outputs`, de cualquier nodo y bajo cualquier clave.
 * El ejemplo oficial lee `images`; los nodos de video guardan bajo otras
 * claves según el nodo (no hay una documentada), así que se toma todo array
 * de objetos con `filename`/`subfolder`/`type` en vez de adivinar el nombre.
 */
export function collectFiles(outputs: unknown): ComfyFile[] {
  if (!isRecord(outputs)) return [];
  const files: ComfyFile[] = [];
  for (const node of Object.values(outputs)) {
    if (!isRecord(node)) continue;
    for (const value of Object.values(node)) {
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (
          isRecord(item) &&
          typeof item["filename"] === "string" &&
          item["filename"].length > 0 &&
          typeof item["type"] === "string"
        ) {
          files.push({
            filename: item["filename"],
            subfolder: typeof item["subfolder"] === "string" ? item["subfolder"] : "",
            type: item["type"],
          });
        }
      }
    }
  }
  return files;
}

/**
 * Los archivos que sirven para `kind`: los de su clase de media, y de ésos los
 * `output` si hay alguno (un workflow suele tener también un Preview, que va
 * a `temp`).
 */
export function pickFiles(files: readonly ComfyFile[], kind: GenMediaKind): ComfyFile[] {
  const ofKind = files.filter((f) =>
    (contentTypeOf(f.filename) ?? "").startsWith(`${kind}/`),
  );
  const saved = ofKind.filter((f) => f.type === "output");
  return saved.length > 0 ? saved : ofKind;
}

/** `GET /view?filename=&subfolder=&type=` (comms_routes: «view an image»). */
export function viewUrl(baseUrl: string, file: ComfyFile): string {
  const query = new URLSearchParams({
    filename: file.filename,
    subfolder: file.subfolder,
    type: file.type,
  });
  return `${baseUrl.trim().replace(/\/+$/, "")}/view?${query.toString()}`;
}
