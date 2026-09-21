/**
 * `BucketStore` en memoria para el limitador de `src/http/rate-limit.ts`.
 *
 * **Alcance honesto:** esto cuenta por proceso. Con dos instancias de la API detrás de
 * un balanceador, el límite efectivo es 60/min × instancias, no 60/min. El PRD §9.6 fija
 * el límite "por workspace", que en un despliegue multi-instancia obliga a un contador
 * compartido (Redis, o una tabla en Postgres con `UPDATE … RETURNING`).
 *
 * Se elige memoria igual porque el contrato que importa —el token bucket, el refill
 * uniforme, y sobre todo el `503` cuando el contador no se puede consultar— vive en
 * `TokenBucketLimiter`, detrás de esta interfaz. Cambiar a Redis es escribir otro
 * `BucketStore`, no tocar ninguna ruta.
 *
 * La entrada se borra cuando el bucket vuelve a estar lleno: un workspace inactivo no
 * tiene por qué ocupar memoria para siempre, y un bucket lleno es indistinguible de uno
 * que nunca existió (`read` → `null` ⇒ el limitador arranca en `limit`).
 */
import type { BucketState, BucketStore } from "../http/rate-limit.js";

export interface MemoryBucketStoreOptions {
  /** Entradas máximas antes de podar. Cota de memoria dura. */
  readonly maxEntries?: number;
}

export function createMemoryBucketStore(
  options: MemoryBucketStoreOptions = {},
): BucketStore & { size(): number } {
  const maxEntries = options.maxEntries ?? 10_000;
  const buckets = new Map<string, BucketState>();

  return {
    async read(key: string): Promise<BucketState | null> {
      return buckets.get(key) ?? null;
    },

    /**
     * Compare-and-swap, no `write` a secas.
     *
     * Entre el `read` y la escritura hay un `await`: con `write`, N peticiones
     * concurrentes del mismo workspace leen todas el mismo estado y **pasan
     * todas**, así que el límite efectivo es hasta N veces el configurado.
     * La comparación es por referencia porque `read` devuelve el objeto
     * guardado: si nadie escribió en el medio, son el mismo.
     */
    async compareAndSwap(
      key: string,
      expected: BucketState | null,
      next: BucketState,
    ): Promise<boolean> {
      const actual = buckets.get(key) ?? null;
      if (actual !== expected) return false;

      // Poda ingenua pero acotada: al tocar el techo se tira la entrada más vieja
      // por orden de inserción. Perder un bucket sólo regala tokens, nunca los
      // quita, así que el peor caso es ser permisivo de más con un workspace.
      if (!buckets.has(key) && buckets.size >= maxEntries) {
        const oldest = buckets.keys().next();
        if (!oldest.done) buckets.delete(oldest.value);
      }
      buckets.set(key, next);
      return true;
    },

    size: () => buckets.size,
  };
}
