/**
 * Validar un workflow de ComfyUI antes de guardarlo — `PU-LATER-003`,
 * `docs/PLAN-USO-PERSONAL.md` §4.
 *
 * En ComfyUI el «modelo» es un workflow **en formato API**: el objeto que
 * `POST /prompt` recibe en `prompt` («submit a prompt to the queue»,
 * https://docs.comfy.org/development/comfyui-server/comms_routes), con la forma
 * `{ [nodeId]: { class_type, inputs } }` que usa el ejemplo oficial
 * `script_examples/websockets_api_example.py`. Los ids de nodo son del
 * usuario y arbitrarios.
 *
 * Lo que se valida acá es lo que haría fallar la inyección **antes** de mandar
 * nada: que cada input marcado exista, que tenga el tipo que se le va a
 * escribir y que no sea un link a otro nodo (`[nodeId, salida]`): pisar un link
 * con un valor rompe el grafo en silencio.
 *
 * Lo que **no** se valida: que los `class_type` existan en el ComfyUI del
 * usuario. Eso lo dice el servidor al encolar (`node_errors`), y el adaptador
 * lo traduce a un `bad_request` legible.
 */
import type { ComfyInputRef, ComfyWorkflowConfig, ModelTask } from "@fastgram/ports";

/** Topes de sanidad del input, no del producto. */
const MAX_WORKFLOW_JSON_CHARS = 1_000_000;
const MAX_WORKFLOW_NODES = 2000;
const MAX_REF_CHARS = 128;
/** El mismo tope que `generationRequestSchema.durationSeconds` (contrato de AI Studio). */
const MAX_VIDEO_SECONDS = 60;

/**
 * Lo que llega para validar: la misma forma que `ComfyWorkflowConfig`, pero
 * con los opcionales que pueden venir en `undefined` (lo que produce Zod).
 */
export interface ComfyWorkflowInput {
  readonly workflow: Readonly<Record<string, unknown>>;
  readonly prompt: ComfyInputRef;
  readonly width?: ComfyInputRef | undefined;
  readonly height?: ComfyInputRef | undefined;
  readonly seed?: ComfyInputRef | undefined;
  readonly image?: ComfyInputRef | undefined;
  readonly durationSeconds?: number | undefined;
}

export type ComfyWorkflowCheck =
  | { readonly ok: true; readonly config: ComfyWorkflowConfig }
  | { readonly ok: false; readonly message: string };

type Binding = "prompt" | "width" | "height" | "seed" | "image";

const EXPECTED: Readonly<Record<Binding, "string" | "number">> = {
  prompt: "string",
  width: "number",
  height: "number",
  seed: "number",
  image: "string",
};

const LABEL: Readonly<Record<Binding, string>> = {
  prompt: "prompt",
  width: "width",
  height: "height",
  seed: "seed",
  image: "input image",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Un link de ComfyUI en formato API: `["<nodeId>", <índice de salida>]`. */
export function isComfyLink(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (typeof value[0] === "string" || typeof value[0] === "number") &&
    typeof value[1] === "number"
  );
}

/**
 * ¿Es un workflow en formato API? Devuelve el mensaje si no. El formato del
 * editor (el `.json` que guarda «Save») tiene `nodes` y `links` como arrays:
 * se reconoce para decir qué exportar en vez de un error genérico.
 */
export function checkComfyApiWorkflow(value: unknown): string | null {
  if (!isRecord(value)) return "The workflow must be a JSON object.";
  if (Array.isArray(value["nodes"]) && Array.isArray(value["links"])) {
    return "This is the editor format. Export the workflow in API format instead.";
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return "The workflow has no nodes.";
  if (entries.length > MAX_WORKFLOW_NODES) return "The workflow has too many nodes.";
  for (const [id, node] of entries) {
    if (
      !isRecord(node) ||
      typeof node["class_type"] !== "string" ||
      !isRecord(node["inputs"])
    ) {
      return `Node ${id.slice(0, 40)} is not in API format (needs class_type and inputs).`;
    }
  }
  return null;
}

function checkRef(
  workflow: Record<string, unknown>,
  ref: ComfyInputRef,
  binding: Binding,
): string | null {
  const name = LABEL[binding];
  if (
    ref.nodeId.length === 0 ||
    ref.input.length === 0 ||
    ref.nodeId.length > MAX_REF_CHARS ||
    ref.input.length > MAX_REF_CHARS
  ) {
    return `Pick the node and input for the ${name}.`;
  }
  const node = workflow[ref.nodeId];
  if (!isRecord(node) || !isRecord(node["inputs"])) {
    return `The workflow has no node ${ref.nodeId} for the ${name}.`;
  }
  const inputs = node["inputs"];
  if (!Object.hasOwn(inputs, ref.input)) {
    return `Node ${ref.nodeId} has no input "${ref.input}" for the ${name}.`;
  }
  const current = inputs[ref.input];
  if (isComfyLink(current)) {
    return `Node ${ref.nodeId} "${ref.input}" is wired to another node; pick a plain value for the ${name}.`;
  }
  if (typeof current !== EXPECTED[binding]) {
    return `Node ${ref.nodeId} "${ref.input}" is not a ${EXPECTED[binding] === "string" ? "text" : "number"} input, so it can't be the ${name}.`;
  }
  return null;
}

/**
 * Valida la configuración entera de una tarea `image`/`video` con `comfyui`.
 * Devuelve una copia limpia (sólo los campos conocidos).
 */
export function checkComfyWorkflowConfig(
  task: ModelTask,
  raw: ComfyWorkflowInput,
): ComfyWorkflowCheck {
  if (task !== "image" && task !== "video") {
    return { ok: false, message: "ComfyUI workflows are only for image and video." };
  }
  const shape = checkComfyApiWorkflow(raw.workflow);
  if (shape !== null) return { ok: false, message: shape };
  if (JSON.stringify(raw.workflow).length > MAX_WORKFLOW_JSON_CHARS) {
    return { ok: false, message: "The workflow is too large." };
  }
  const workflow = raw.workflow as Record<string, unknown>;

  // `ImageGenRequest` no trae imagen de entrada (sólo referencias públicas
  // para los proveedores que las aceptan): un img2img no tendría qué recibir.
  if (task === "image" && raw.image !== undefined) {
    return {
      ok: false,
      message: "Image workflows can't take an input image yet; only video workflows can.",
    };
  }
  if ((raw.width === undefined) !== (raw.height === undefined)) {
    return { ok: false, message: "Pick both width and height, or neither." };
  }
  const bindings: [Binding, ComfyInputRef | undefined][] = [
    ["prompt", raw.prompt],
    ["width", raw.width],
    ["height", raw.height],
    ["seed", raw.seed],
    ["image", raw.image],
  ];
  for (const [binding, ref] of bindings) {
    if (ref === undefined) continue;
    const problem = checkRef(workflow, ref, binding);
    if (problem !== null) return { ok: false, message: problem };
  }

  let durationSeconds: number | undefined;
  if (task === "video") {
    const d = raw.durationSeconds;
    if (d === undefined || !Number.isInteger(d) || d <= 0 || d > MAX_VIDEO_SECONDS) {
      return {
        ok: false,
        message: "Say how many seconds the workflow's clip lasts (a whole number).",
      };
    }
    durationSeconds = d;
  }

  const ref = (r: ComfyInputRef): ComfyInputRef => ({ nodeId: r.nodeId, input: r.input });
  return {
    ok: true,
    config: {
      workflow,
      prompt: ref(raw.prompt),
      ...(raw.width === undefined ? {} : { width: ref(raw.width) }),
      ...(raw.height === undefined ? {} : { height: ref(raw.height) }),
      ...(raw.seed === undefined ? {} : { seed: ref(raw.seed) }),
      ...(raw.image === undefined ? {} : { image: ref(raw.image) }),
      ...(durationSeconds === undefined ? {} : { durationSeconds }),
    },
  };
}
