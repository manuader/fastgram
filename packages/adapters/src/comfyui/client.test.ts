/**
 * `ComfyUiClient` contra un servidor HTTP **local de prueba** (`node:http`,
 * puerto efímero) que contesta lo que documentan
 * https://docs.comfy.org/development/comfyui-server/comms_routes y el código
 * citado en la cabecera de `client.ts` (`server.py`, `execution.py`, el
 * ejemplo `websockets_api_example.py`). No hay ComfyUI real en esta máquina.
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isPortError, type ComfyWorkflowConfig } from "@fastgram/ports";

import { ComfyUiClient } from "./client.js";

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly contentType: string;
  readonly body: string;
}

type Handler = (req: Seen, res: ServerResponse) => void;

let server: Server;
let base: string;
let seen: Seen[];
let handler: Handler;

const send = (
  res: ServerResponse,
  status: number,
  body: unknown,
  type = "application/json",
) => {
  res.writeHead(status, { "content-type": type });
  res.end(
    typeof body === "string" || body instanceof Buffer ? body : JSON.stringify(body),
  );
};

beforeEach(async () => {
  seen = [];
  handler = (_req, res) => {
    send(res, 404, "404: Not Found", "text/plain");
  };
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const entry: Seen = {
        method: req.method ?? "",
        url: req.url ?? "",
        contentType: req.headers["content-type"] ?? "",
        body: Buffer.concat(chunks).toString("latin1"),
      };
      seen.push(entry);
      handler(entry, res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** Un txt2img mínimo en formato API, con ids **arbitrarios** (no 3/5/6/7). */
const WORKFLOW = {
  "ckpt-a": {
    class_type: "CheckpointLoaderSimple",
    inputs: { ckpt_name: "sdxl.safetensors" },
  },
  "91": {
    class_type: "CLIPTextEncode",
    inputs: { text: "old prompt", clip: ["ckpt-a", 1] },
  },
  neg: { class_type: "CLIPTextEncode", inputs: { text: "blurry", clip: ["ckpt-a", 1] } },
  latent_x: {
    class_type: "EmptyLatentImage",
    inputs: { width: 1024, height: 1024, batch_size: 1 },
  },
  s1: {
    class_type: "KSampler",
    inputs: {
      seed: 42,
      steps: 20,
      cfg: 7,
      model: ["ckpt-a", 0],
      positive: ["91", 0],
      negative: ["neg", 0],
      latent_image: ["latent_x", 0],
    },
  },
  save: { class_type: "SaveImage", inputs: { filename_prefix: "fg", images: ["s1", 0] } },
};

const IMAGE_CONFIG: ComfyWorkflowConfig = {
  workflow: WORKFLOW,
  prompt: { nodeId: "91", input: "text" },
  width: { nodeId: "latent_x", input: "width" },
  height: { nodeId: "latent_x", input: "height" },
  seed: { nodeId: "s1", input: "seed" },
};

const imageClient = (config: ComfyWorkflowConfig = IMAGE_CONFIG) =>
  new ComfyUiClient({
    baseUrl: base,
    task: "image",
    workflow: config,
    model: "sdxl-basic",
    timeoutMs: 2000,
    random: () => 0.5,
  });

async function portError(
  p: Promise<unknown>,
): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (e) {
    if (isPortError(e)) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("expected a PortError");
}

describe("ComfyUiClient — ficha y costo", () => {
  it("una ficha por workflow, con el nombre como id, y costo 0", async () => {
    const client = imageClient();
    const [spec] = client.models();
    expect(spec).toMatchObject({
      id: "sdxl-basic",
      kind: "image",
      counts: [1],
      imageInput: "none",
      aspectFromImage: false,
    });
    expect(spec?.aspectRatios).toContain("9:16");
    const estimate = await client.estimateImage({
      model: "sdxl-basic",
      prompt: "x",
      aspectRatio: "1:1",
    });
    expect(estimate.usd).toBe(0);
    expect(seen).toHaveLength(0);
  });

  it("sin width/height marcados, el tamaño es el del workflow (no se elige)", () => {
    const { width: _w, height: _h, ...rest } = IMAGE_CONFIG;
    const [spec] = imageClient(rest).models();
    expect(spec?.aspectFromImage).toBe(true);
    expect(spec?.aspectRatios).toEqual([]);
  });
});

describe("ComfyUiClient — enviar", () => {
  it("POST /prompt con el prompt, el tamaño y la semilla inyectados en los nodos marcados", async () => {
    handler = (req, res) => {
      if (req.method === "POST" && req.url === "/prompt") {
        send(res, 200, { prompt_id: "p-123", number: 0, node_errors: {} });
      } else send(res, 404, "nope", "text/plain");
    };
    const sub = await imageClient().generateImage({
      model: "sdxl-basic",
      prompt: "  a red fox  ",
      aspectRatio: "9:16",
    });
    expect(sub).toEqual({
      kind: "accepted",
      handle: { requestId: "p-123", statusUrl: `${base}/history/p-123` },
    });
    const body = JSON.parse(seen[0]?.body ?? "{}") as {
      prompt: typeof WORKFLOW;
      client_id: string;
    };
    expect(typeof body.client_id).toBe("string");
    expect(body.prompt["91"].inputs.text).toBe("a red fox");
    // El negativo y los links quedan intactos.
    expect(body.prompt.neg.inputs.text).toBe("blurry");
    expect(body.prompt["91"].inputs.clip).toEqual(["ckpt-a", 1]);
    // 9:16 conservando ~1 MP del workflow, múltiplos de 16.
    expect(body.prompt.latent_x.inputs).toMatchObject({ width: 768, height: 1360 });
    expect(body.prompt.s1.inputs.seed).toBe(2 ** 31);
    // El workflow guardado no se ensucia.
    expect(WORKFLOW["91"].inputs.text).toBe("old prompt");
  });

  it("servidor caído → provider_unavailable, con la URL para que el usuario la revise", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const err = await portError(
      imageClient().generateImage({
        model: "sdxl-basic",
        prompt: "x",
        aspectRatio: "1:1",
      }),
    );
    expect(err.code).toBe("provider_unavailable");
    expect(err.message).toContain(base);
    // Para que `afterEach` pueda cerrar algo.
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });

  it("400 de validación (nodo faltante) → bad_request con el nodo y el mensaje", async () => {
    handler = (_req, res) => {
      // Forma de `execution.py` → `server.py`: `{ error, node_errors }`.
      send(res, 400, {
        error: {
          type: "prompt_outputs_failed_validation",
          message: "Prompt outputs failed validation",
          details: "",
          extra_info: {},
        },
        node_errors: {
          s1: {
            errors: [
              {
                type: "value_not_in_list",
                message: "Value not in list",
                details: "ckpt_name: 'sdxl.safetensors' not in []",
                extra_info: {},
              },
            ],
            dependent_outputs: ["save"],
            class_type: "KSampler",
          },
        },
      });
    };
    const err = await portError(
      imageClient().generateImage({
        model: "sdxl-basic",
        prompt: "x",
        aspectRatio: "1:1",
      }),
    );
    expect(err.code).toBe("bad_request");
    expect(err.message).toContain("Prompt outputs failed validation");
    expect(err.message).toContain("node s1 (KSampler)");
    expect(err.message).toContain("ckpt_name");
  });

  it("nodo de tipo desconocido (missing_node_type) → bad_request legible", async () => {
    handler = (_req, res) => {
      send(res, 400, {
        error: {
          type: "missing_node_type",
          message:
            "Node 'ID #s1' has no class_type. The workflow may be corrupted or a custom node is missing.",
          details: "Node ID '#s1'",
          extra_info: { node_id: "s1", class_type: null, node_title: null },
        },
        node_errors: {},
      });
    };
    const err = await portError(
      imageClient().generateImage({
        model: "sdxl-basic",
        prompt: "x",
        aspectRatio: "1:1",
      }),
    );
    expect(err.code).toBe("bad_request");
    expect(err.message).toContain("custom node is missing");
  });

  it("un input marcado que ya no existe en el workflow → bad_request sin llamar", async () => {
    const err = await portError(
      imageClient({
        ...IMAGE_CONFIG,
        prompt: { nodeId: "zzz", input: "text" },
      }).generateImage({
        model: "sdxl-basic",
        prompt: "x",
        aspectRatio: "1:1",
      }),
    );
    expect(err.code).toBe("bad_request");
    expect(err.message).toContain("zzz");
    expect(seen).toHaveLength(0);
  });

  it("otro modelo que el workflow configurado → bad_request", async () => {
    const err = await portError(
      imageClient().generateImage({ model: "other", prompt: "x", aspectRatio: "1:1" }),
    );
    expect(err.code).toBe("bad_request");
  });

  it("500 → provider_unavailable", async () => {
    handler = (_req, res) => {
      send(res, 500, "boom", "text/plain");
    };
    const err = await portError(
      imageClient().generateImage({
        model: "sdxl-basic",
        prompt: "x",
        aspectRatio: "1:1",
      }),
    );
    expect(err.code).toBe("provider_unavailable");
  });
});

describe("ComfyUiClient — polling y descarga", () => {
  const handle = () => ({ requestId: "p-1", statusUrl: `${base}/history/p-1` });

  it("{} mientras corre → in_progress; al terminar, URLs de /view de los `output`", async () => {
    let calls = 0;
    handler = (req, res) => {
      if (req.url === "/history/p-1") {
        calls += 1;
        if (calls === 1) {
          send(res, 200, {});
          return;
        }
        send(res, 200, {
          "p-1": {
            prompt: [],
            outputs: {
              preview: {
                images: [{ filename: "tmp_00001_.png", subfolder: "", type: "temp" }],
              },
              save: {
                images: [
                  { filename: "fg_00001_.png", subfolder: "sub dir", type: "output" },
                ],
              },
            },
            status: { status_str: "success", completed: true, messages: [] },
          },
        });
        return;
      }
      if (req.url.startsWith("/view?")) {
        send(res, 200, Buffer.from([0x89, 0x50, 0x4e, 0x47]), "image/png");
        return;
      }
      send(res, 404, "nope", "text/plain");
    };
    const client = imageClient();
    expect(await client.poll(handle())).toEqual({ status: "in_progress", outputs: [] });
    const done = await client.poll(handle());
    expect(done.status).toBe("completed");
    expect(done.outputs).toHaveLength(1);
    const out = done.outputs[0];
    expect(out?.contentType).toBe("image/png");
    const url = new URL(out?.url ?? "");
    expect(url.origin).toBe(base);
    expect(url.pathname).toBe("/view");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      filename: "fg_00001_.png",
      subfolder: "sub dir",
      type: "output",
    });
    // La URL descarga de verdad del servidor de prueba.
    const res = await fetch(url);
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
    );
  });

  it("status_str error → failed con el exception_message del nodo", async () => {
    handler = (_req, res) => {
      send(res, 200, {
        "p-1": {
          prompt: [],
          outputs: {},
          status: {
            status_str: "error",
            completed: false,
            messages: [
              ["execution_start", { prompt_id: "p-1", timestamp: 1 }],
              [
                "execution_error",
                {
                  prompt_id: "p-1",
                  node_id: "s1",
                  node_type: "KSampler",
                  exception_message: "CUDA out of memory",
                  exception_type: "torch.OutOfMemoryError",
                  traceback: ["..."],
                },
              ],
            ],
          },
        },
      });
    };
    const state = await imageClient().poll(handle());
    expect(state.status).toBe("failed");
    expect(state.message).toContain("node s1 (KSampler)");
    expect(state.message).toContain("CUDA out of memory");
  });

  it("terminó sin guardar nada → failed que pide un nodo Save", async () => {
    handler = (_req, res) => {
      send(res, 200, {
        "p-1": {
          prompt: [],
          outputs: {},
          status: { status_str: "success", completed: true, messages: [] },
        },
      });
    };
    const state = await imageClient().poll(handle());
    expect(state).toMatchObject({ status: "failed" });
    expect(state.message).toContain("Save node");
  });

  it("una URL de estado de otro origen no se sigue", async () => {
    const err = await portError(
      imageClient().poll({
        requestId: "p-1",
        statusUrl: "http://evil.example/history/p-1",
      }),
    );
    expect(err.code).toBe("provider_contract_violation");
    expect(seen).toHaveLength(0);
  });

  it("history de un servidor que se cayó → provider_unavailable (reintentable)", async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const err = await portError(imageClient().poll(handle()));
    expect(err.code).toBe("provider_unavailable");
    server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  });
});

describe("ComfyUiClient — video con imagen de entrada", () => {
  const VIDEO: ComfyWorkflowConfig = {
    workflow: {
      "12": { class_type: "LoadImage", inputs: { image: "example.png" } },
      "6": { class_type: "CLIPTextEncode", inputs: { text: "", clip: ["1", 0] } },
      "50": {
        class_type: "WanImageToVideo",
        inputs: { width: 832, height: 480, length: 81, start_image: ["12", 0] },
      },
      "3": { class_type: "KSampler", inputs: { seed: 1, latent_image: ["50", 2] } },
      "60": {
        class_type: "SaveVideo",
        inputs: { filename_prefix: "v", video: ["3", 0] },
      },
    },
    prompt: { nodeId: "6", input: "text" },
    width: { nodeId: "50", input: "width" },
    height: { nodeId: "50", input: "height" },
    seed: { nodeId: "3", input: "seed" },
    image: { nodeId: "12", input: "image" },
    durationSeconds: 5,
  };

  it("baja la imagen, la sube por /upload/image y pone su nombre en LoadImage", async () => {
    handler = (req, res) => {
      if (req.url === "/media/frame.png") {
        send(res, 200, Buffer.from([1, 2, 3]), "image/png");
      } else if (req.url === "/upload/image") {
        send(res, 200, { name: "fastgram-abc.png", subfolder: "", type: "input" });
      } else if (req.url === "/prompt") {
        send(res, 200, { prompt_id: "v-1", number: 3, node_errors: {} });
      } else if (req.url === "/history/v-1") {
        send(res, 200, {
          "v-1": {
            outputs: {
              "60": {
                images: [
                  { filename: "v_00001_.mp4", subfolder: "video", type: "output" },
                ],
                animated: [true],
              },
            },
            status: { status_str: "success", completed: true, messages: [] },
          },
        });
      } else send(res, 404, "nope", "text/plain");
    };
    const client = new ComfyUiClient({
      baseUrl: base,
      task: "video",
      workflow: VIDEO,
      model: "wan-i2v",
      timeoutMs: 2000,
      random: () => 0,
    });
    expect(client.models()[0]).toMatchObject({
      kind: "video",
      durationsSeconds: [5],
      imageInput: "required",
    });
    const sub = await client.generateVideo({
      model: "wan-i2v",
      prompt: "the fox runs",
      durationSeconds: 5,
      aspectRatio: "16:9",
      imageUrl: `${base}/media/frame.png`,
    });
    expect(sub.kind).toBe("accepted");

    const upload = seen.find((s) => s.url === "/upload/image");
    expect(upload?.method).toBe("POST");
    expect(upload?.contentType).toMatch(/^multipart\/form-data/);
    expect(upload?.body).toContain('name="image"');
    expect(upload?.body).toContain('name="type"');

    const prompt = JSON.parse(seen.find((s) => s.url === "/prompt")?.body ?? "{}") as {
      prompt: Record<string, { inputs: Record<string, unknown> }>;
    };
    expect(prompt.prompt["12"]?.inputs["image"]).toBe("fastgram-abc.png");
    expect(prompt.prompt["6"]?.inputs["text"]).toBe("the fox runs");
    expect(prompt.prompt["50"]?.inputs["start_image"]).toEqual(["12", 0]);
    expect(prompt.prompt["3"]?.inputs["seed"]).toBe(0);

    if (sub.kind !== "accepted") throw new Error("unreachable");
    const state = await client.poll(sub.handle);
    expect(state.status).toBe("completed");
    expect(state.outputs[0]?.contentType).toBe("video/mp4");
  });

  it("sin imagen de entrada → bad_request antes de llamar", async () => {
    const client = new ComfyUiClient({
      baseUrl: base,
      task: "video",
      workflow: VIDEO,
      model: "w",
    });
    const err = await portError(
      client.generateVideo({
        model: "w",
        prompt: "x",
        durationSeconds: 5,
        aspectRatio: "16:9",
      }),
    );
    expect(err.code).toBe("bad_request");
    expect(seen).toHaveLength(0);
  });

  it("otra duración que la declarada → bad_request", async () => {
    const client = new ComfyUiClient({
      baseUrl: base,
      task: "video",
      workflow: VIDEO,
      model: "w",
    });
    const err = await portError(
      client.generateVideo({
        model: "w",
        prompt: "x",
        durationSeconds: 10,
        aspectRatio: "16:9",
        imageUrl: `${base}/media/frame.png`,
      }),
    );
    expect(err.code).toBe("bad_request");
  });
});

describe("ComfyUiClient — Test connection", () => {
  it("GET /system_stats de un ComfyUI → ok, sin workflow", async () => {
    handler = (req, res) => {
      if (req.url === "/system_stats") {
        send(res, 200, {
          system: { os: "posix", comfyui_version: "0.3.60", python_version: "3.12" },
          devices: [{ name: "mps", type: "mps", index: 0, vram_total: 0, vram_free: 0 }],
        });
      } else send(res, 404, "nope", "text/plain");
    };
    const check = await new ComfyUiClient({ baseUrl: `${base}/` }).checkCredentials();
    expect(check.probe).toBe("system_stats");
    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual(["GET /system_stats"]);
  });

  it("algo que contesta pero no es ComfyUI → contract violation / not_found", async () => {
    handler = (req, res) => {
      if (req.url === "/system_stats") send(res, 200, { hello: "world" });
      else send(res, 404, "nope", "text/plain");
    };
    const err = await portError(new ComfyUiClient({ baseUrl: base }).checkCredentials());
    expect(err.code).toBe("provider_contract_violation");
    handler = (_req, res) => {
      send(res, 404, "nope", "text/plain");
    };
    const err2 = await portError(new ComfyUiClient({ baseUrl: base }).checkCredentials());
    expect(err2.code).toBe("not_found");
  });
});
