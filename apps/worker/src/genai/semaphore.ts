/**
 * Un semáforo en memoria por proveedor — `PU-MODEL-003`/`004`.
 *
 * Higgsfield documenta que su límite principal es de **concurrencia**: pedidos
 * «queued or processing at the same time», con un 400 al pasarse
 * (`docs.higgsfield.ai/docs/concepts/rate-limits`, el ejemplo dice 4), y
 * recomienda «a worker pool or semaphore». fal arranca las cuentas nuevas con
 * 2 (`fal.ai/docs/documentation/model-apis/concurrency-limits`). Por eso el
 * default es 2 y se cambia con `FASTGRAM_GENAI_CONCURRENCY`.
 *
 * Es por proceso: con un solo worker (uso personal) es el tope real. Con más
 * de uno, cada uno tiene el suyo y un 400/429 de concurrencia se reintenta
 * igual (ver el handler).
 */
export class Semaphore {
  readonly #max: number;
  #active = 0;
  readonly #waiting: (() => void)[] = [];

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) throw new Error("semaphore size must be >= 1");
    this.#max = max;
  }

  get active(): number {
    return this.#active;
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#active >= this.#max) {
      await new Promise<void>((resolve) => {
        this.#waiting.push(resolve);
      });
    } else {
      this.#active += 1;
    }
    try {
      return await fn();
    } finally {
      const next = this.#waiting.shift();
      // El lugar pasa directo al siguiente: `#active` no baja.
      if (next !== undefined) next();
      else this.#active -= 1;
    }
  }
}

export const DEFAULT_GENAI_CONCURRENCY = 2;
export const GENAI_CONCURRENCY_ENV = "FASTGRAM_GENAI_CONCURRENCY";

export function genAiConcurrencyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env[GENAI_CONCURRENCY_ENV]?.trim() ?? "";
  if (!/^\d+$/.test(raw)) return DEFAULT_GENAI_CONCURRENCY;
  const n = Number(raw);
  return n >= 1 && n <= 32 ? n : DEFAULT_GENAI_CONCURRENCY;
}
