/**
 * El borrador del workflow de ComfyUI en Settings → Models, sin React —
 * `PU-LATER-003`.
 *
 * El usuario pega (o sube) el workflow **en formato API** —el objeto
 * `{ [nodeId]: { class_type, inputs } }` que `POST /prompt` recibe— y marca
 * qué inputs son el prompt, el tamaño, la semilla y la imagen de entrada. Para
 * no pedirle que lea ids de nodo, al pegarlo se **detectan** los candidatos
 * obvios y se le muestran para que los confirme:
 *
 * - Prompt: se sigue el link `positive` de cada sampler hasta un nodo con un
 *   `text` de texto (un `CLIPTextEncode`, aunque haya un nodo en el medio,
 *   como el `WanImageToVideo` de un image-to-video). El que cuelga de
 *   `negative` no se elige nunca.
 * - Tamaño: un `Empty…Latent…` con `width`/`height` numéricos, o si no el
 *   primer nodo que los tenga.
 * - Semilla: `seed` (o `noise_seed`) de un sampler.
 * - Imagen de entrada (sólo video): el `image` de un `LoadImage`.
 *
 * La validación que manda es la del servidor (`core`): la de acá es la que se
 * puede decir sin preguntarle.
 */
import type { ComfyInputRef, ComfyWorkflow, ModelTask } from "@fastgram/contracts";

export type ComfyBinding = "prompt" | "width" | "height" | "seed" | "image";

export interface ComfyDraft {
  /** El JSON tal como está en el textarea. */
  readonly text: string;
  /** Cada binding como `refKey(...)`, o `""` sin marcar. */
  readonly refs: Readonly<Record<ComfyBinding, string>>;
  /** Sólo video. Texto del input. */
  readonly duration: string;
  /** Los bindings salieron de la detección y el usuario no los tocó. */
  readonly detected: boolean;
}

type Workflow = Record<string, unknown>;

export interface ComfyInputOption {
  readonly key: string;
  readonly nodeId: string;
  readonly input: string;
  readonly classType: string;
  readonly title: string | null;
  readonly valueType: "string" | "number";
}

export type ParsedWorkflow =
  | { readonly ok: true; readonly workflow: Workflow }
  | { readonly ok: false; readonly message: string };

const EMPTY_REFS: Readonly<Record<ComfyBinding, string>> = {
  prompt: "",
  width: "",
  height: "",
  seed: "",
  image: "",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLink(value: unknown): value is [string | number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    (typeof value[0] === "string" || typeof value[0] === "number") &&
    typeof value[1] === "number"
  );
}

/** Un ref como valor de un `<select>`. JSON: los ids pueden tener cualquier cosa. */
export function refKey(ref: ComfyInputRef): string {
  return JSON.stringify([ref.nodeId, ref.input]);
}

export function refFromKey(key: string): ComfyInputRef | null {
  if (key === "") return null;
  try {
    const value: unknown = JSON.parse(key);
    if (
      Array.isArray(value) &&
      typeof value[0] === "string" &&
      typeof value[1] === "string"
    ) {
      return { nodeId: value[0], input: value[1] };
    }
  } catch {
    // cae abajo
  }
  return null;
}

/** El texto pegado → workflow en formato API, o por qué no lo es. */
export function parseWorkflow(text: string): ParsedWorkflow {
  if (text.trim() === "") return { ok: false, message: "Paste a workflow." };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, message: "That is not valid JSON." };
  }
  if (!isRecord(value))
    return { ok: false, message: "The workflow must be a JSON object." };
  if (Array.isArray(value["nodes"]) && Array.isArray(value["links"])) {
    return {
      ok: false,
      message:
        "This is the editor format. In ComfyUI, export the workflow in API format.",
    };
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return { ok: false, message: "The workflow has no nodes." };
  for (const [id, node] of entries) {
    if (
      !isRecord(node) ||
      typeof node["class_type"] !== "string" ||
      !isRecord(node["inputs"])
    ) {
      return {
        ok: false,
        message: `Node ${id} has no class_type/inputs — export the workflow in API format.`,
      };
    }
  }
  return { ok: true, workflow: value };
}

function nodeOf(workflow: Workflow, id: string): Record<string, unknown> | null {
  const node = workflow[id];
  return isRecord(node) ? node : null;
}

function inputsOf(workflow: Workflow, id: string): Record<string, unknown> {
  const inputs = nodeOf(workflow, id)?.["inputs"];
  return isRecord(inputs) ? inputs : {};
}

function classOf(workflow: Workflow, id: string): string {
  const c = nodeOf(workflow, id)?.["class_type"];
  return typeof c === "string" ? c : "";
}

/** Todos los inputs con un valor plano (no un link), para los `<select>`. */
export function listInputs(workflow: Workflow): ComfyInputOption[] {
  const options: ComfyInputOption[] = [];
  for (const id of Object.keys(workflow)) {
    const node = nodeOf(workflow, id);
    const meta = node?.["_meta"];
    const title =
      isRecord(meta) && typeof meta["title"] === "string" ? meta["title"] : null;
    for (const [input, value] of Object.entries(inputsOf(workflow, id))) {
      if (typeof value !== "string" && typeof value !== "number") continue;
      options.push({
        key: refKey({ nodeId: id, input }),
        nodeId: id,
        input,
        classType: classOf(workflow, id),
        title,
        valueType: typeof value === "string" ? "string" : "number",
      });
    }
  }
  return options;
}

/** Qué tipo de valor lleva cada binding. */
export const BINDING_TYPE: Readonly<Record<ComfyBinding, "string" | "number">> = {
  prompt: "string",
  width: "number",
  height: "number",
  seed: "number",
  image: "string",
};

/** Nodos que muestrean: tienen `positive` como link. */
function samplers(workflow: Workflow): string[] {
  return Object.keys(workflow).filter((id) => isLink(inputsOf(workflow, id)["positive"]));
}

/** Sigue `from` por los links de `via` hasta un nodo con `text` de texto. */
function followToText(workflow: Workflow, from: string, via: string): string | null {
  let current = inputsOf(workflow, from)[via];
  for (let depth = 0; depth < 6 && isLink(current); depth++) {
    const id = String(current[0]);
    const inputs = inputsOf(workflow, id);
    if (typeof inputs["text"] === "string") return id;
    current = inputs[via];
  }
  return null;
}

/** Los candidatos obvios. Ver la cabecera. */
export function detectBindings(
  workflow: Workflow,
  task: ModelTask,
): Partial<Record<ComfyBinding, ComfyInputRef>> {
  const found: Partial<Record<ComfyBinding, ComfyInputRef>> = {};
  const ids = Object.keys(workflow);

  const negatives = new Set<string>();
  for (const s of samplers(workflow)) {
    const neg = followToText(workflow, s, "negative");
    if (neg !== null) negatives.add(neg);
  }
  for (const s of samplers(workflow)) {
    const pos = followToText(workflow, s, "positive");
    if (pos !== null) {
      found.prompt = { nodeId: pos, input: "text" };
      break;
    }
  }
  if (found.prompt === undefined) {
    const id = ids.find(
      (i) =>
        !negatives.has(i) &&
        classOf(workflow, i).startsWith("CLIPTextEncode") &&
        typeof inputsOf(workflow, i)["text"] === "string",
    );
    if (id !== undefined) found.prompt = { nodeId: id, input: "text" };
  }

  const sized = (i: string) => {
    const inputs = inputsOf(workflow, i);
    return typeof inputs["width"] === "number" && typeof inputs["height"] === "number";
  };
  const sizeNode =
    ids.find((i) => /^Empty.*Latent/.test(classOf(workflow, i)) && sized(i)) ??
    ids.find(sized);
  if (sizeNode !== undefined) {
    found.width = { nodeId: sizeNode, input: "width" };
    found.height = { nodeId: sizeNode, input: "height" };
  }

  const seedIn = (i: string): string | null => {
    const inputs = inputsOf(workflow, i);
    if (typeof inputs["seed"] === "number") return "seed";
    if (typeof inputs["noise_seed"] === "number") return "noise_seed";
    return null;
  };
  const seedNode =
    samplers(workflow).find((i) => seedIn(i) !== null) ??
    ids.find((i) => seedIn(i) !== null);
  if (seedNode !== undefined) {
    const input = seedIn(seedNode);
    if (input !== null) found.seed = { nodeId: seedNode, input };
  }

  if (task === "video") {
    const load = ids.find(
      (i) =>
        classOf(workflow, i) === "LoadImage" &&
        typeof inputsOf(workflow, i)["image"] === "string",
    );
    if (load !== undefined) found.image = { nodeId: load, input: "image" };
  }
  return found;
}

/** Lo guardado → borrador. */
export function comfyDraftFrom(saved: ComfyWorkflow | null | undefined): ComfyDraft {
  if (saved === null || saved === undefined) {
    return { text: "", refs: EMPTY_REFS, duration: "", detected: false };
  }
  const key = (r: ComfyInputRef | undefined) => (r === undefined ? "" : refKey(r));
  return {
    text: JSON.stringify(saved.workflow, null, 2),
    refs: {
      prompt: key(saved.prompt),
      width: key(saved.width),
      height: key(saved.height),
      seed: key(saved.seed),
      image: key(saved.image),
    },
    duration: saved.durationSeconds === undefined ? "" : String(saved.durationSeconds),
    detected: false,
  };
}

/** Texto nuevo: si parsea, se detectan los bindings y se ofrecen para confirmar. */
export function withWorkflowText(
  draft: ComfyDraft,
  text: string,
  task: ModelTask,
): ComfyDraft {
  const parsed = parseWorkflow(text);
  if (!parsed.ok) return { ...draft, text, refs: EMPTY_REFS, detected: false };
  const found = detectBindings(parsed.workflow, task);
  const key = (r: ComfyInputRef | undefined) => (r === undefined ? "" : refKey(r));
  return {
    ...draft,
    text,
    refs: {
      prompt: key(found.prompt),
      width: key(found.width),
      height: key(found.height),
      seed: key(found.seed),
      image: key(found.image),
    },
    detected: true,
  };
}

export function withRef(
  draft: ComfyDraft,
  binding: ComfyBinding,
  key: string,
): ComfyDraft {
  return { ...draft, refs: { ...draft.refs, [binding]: key }, detected: false };
}

export type ComfyField = "workflow" | "prompt" | "size" | "duration";

export function comfyErrors(
  draft: ComfyDraft,
  task: ModelTask,
): Partial<Record<ComfyField, string>> {
  const errors: Partial<Record<ComfyField, string>> = {};
  const parsed = parseWorkflow(draft.text);
  if (!parsed.ok) {
    errors.workflow = parsed.message;
    return errors;
  }
  if (refFromKey(draft.refs.prompt) === null) {
    errors.prompt = "Pick the input that takes the prompt.";
  }
  if ((draft.refs.width === "") !== (draft.refs.height === "")) {
    errors.size = "Pick both width and height, or neither.";
  }
  if (task === "video") {
    const d = draft.duration.trim();
    if (!/^\d+$/.test(d) || Number(d) <= 0 || Number(d) > 60) {
      errors.duration = "How many seconds the clip lasts (1–60).";
    }
  }
  return errors;
}

/** Borrador → `comfyWorkflow` del `PUT`. `null` si todavía no se puede mandar. */
export function toComfyWorkflow(
  draft: ComfyDraft,
  task: ModelTask,
): ComfyWorkflow | null {
  if (Object.keys(comfyErrors(draft, task)).length > 0) return null;
  const parsed = parseWorkflow(draft.text);
  const prompt = refFromKey(draft.refs.prompt);
  if (!parsed.ok || prompt === null) return null;
  const ref = (b: ComfyBinding) => refFromKey(draft.refs[b]) ?? undefined;
  const width = ref("width");
  const height = ref("height");
  const seed = ref("seed");
  const image = task === "video" ? ref("image") : undefined;
  return {
    workflow: parsed.workflow,
    prompt,
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
    ...(seed === undefined ? {} : { seed }),
    ...(image === undefined ? {} : { image }),
    ...(task === "video" ? { durationSeconds: Number(draft.duration.trim()) } : {}),
  };
}

/** Cambió algo respecto de lo guardado. Compara el workflow parseado, no el texto. */
export function comfyDirty(
  draft: ComfyDraft,
  saved: ComfyWorkflow | null | undefined,
): boolean {
  const base = comfyDraftFrom(saved);
  if (
    draft.duration.trim() !== base.duration ||
    (Object.keys(draft.refs) as ComfyBinding[]).some(
      (b) => draft.refs[b] !== base.refs[b],
    )
  ) {
    return true;
  }
  const a = parseWorkflow(draft.text);
  const b = parseWorkflow(base.text);
  if (a.ok !== b.ok) return true;
  if (a.ok && b.ok) return JSON.stringify(a.workflow) !== JSON.stringify(b.workflow);
  return draft.text !== base.text;
}
