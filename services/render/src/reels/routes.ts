/**
 * Rutas del motor de reels. Se registran desde `http/server.ts`.
 *
 * **Concurrencia 1**: un render de reel lanza Chrome y encodea 1080×1920; dos a
 * la vez en una Mac de 16 GB con la app, Ollama y Laya corriendo duplican el
 * tiempo de los dos (y la memoria). Los que llegan esperan en una cola corta
 * (`RENDER_REEL_QUEUE_MAX`); más allá se rechazan en vez de acumular trabajo
 * que el cliente ya abandonó. El presupuesto (`RENDER_REEL_TIMEOUT_MS`) cuenta
 * desde que llega el request, cola incluida, y cancela el render en curso.
 */
import type { FastifyInstance } from "fastify";
import { RenderError } from "../errors.js";
import { artifactHref } from "../http/artifacts.js";
import { previewReel, renderReel, type ReelEngineDeps } from "./engine.js";

export class SerialQueue {
  #tail: Promise<void> = Promise.resolve();
  /** Tareas aceptadas y no terminadas: la que corre más las que esperan. */
  #pending = 0;

  constructor(private readonly maxWaiting: number) {}

  get pending(): number {
    return this.#pending;
  }

  /**
   * Corre `task` cuando le toca. `signal` abortado mientras espera = sale sin
   * correr; abortado mientras corre = `task` lo recibe y decide.
   */
  run<T>(task: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (this.#pending >= 1 + this.maxWaiting) {
      return Promise.reject(
        new RenderError("render_timeout", "hay demasiados reels en cola", {
          details: { reason: "queue_full", pending: this.#pending },
        }),
      );
    }
    this.#pending += 1;
    const previous = this.#tail;
    let release!: () => void;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return (async () => {
      try {
        await previous;
        if (signal.aborted) {
          throw new RenderError(
            "render_timeout",
            "el reel esperó en cola más que su presupuesto",
            {
              details: { reason: "queued_too_long" },
            },
          );
        }
        return await task();
      } finally {
        this.#pending -= 1;
        release();
      }
    })();
  }
}

export function registerReelRoutes(app: FastifyInstance, deps: ReelEngineDeps): void {
  const queue = new SerialQueue(deps.reel.queueMax);

  app.post("/reels/render", async (request, reply) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.reel.timeoutMs);
    try {
      const result = await queue.run(
        () => renderReel(request.body, deps, controller.signal),
        controller.signal,
      );
      return await reply.status(200).send({
        type: "reel",
        href: artifactHref(result.cacheKey, "mp4"),
        bytes: result.bytes,
        cache: result.cache,
        durationSec: result.durationSec,
        warnings: result.warnings,
        captions: result.captions,
        timings: result.timings,
      });
    } finally {
      clearTimeout(timer);
    }
  });

  /**
   * La composición HTML para el iframe del editor. No pasa por la cola: no
   * lanza Chrome (el que renderiza es el navegador del usuario); sólo baja,
   * recorta croma (cacheado) y compila.
   */
  app.post("/reels/preview-html", async (request, reply) => {
    const result = await previewReel(request.body, deps);
    return reply.status(200).send(result);
  });
}
