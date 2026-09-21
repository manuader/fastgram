import { describe, expect, it } from "vitest";
import { describeStorageContract } from "@fastgram/ports";
import { FixedClock, systemClock } from "../clock/index.js";
import { MemoryStorage } from "./memory-storage.js";

/**
 * Primera ejecución real de una suite de contrato de puerto.
 *
 * Vale por dos cosas. La obvia: verifica que `MemoryStorage` cumple el
 * contrato. La que importa más: verifica que **el armazón funciona con
 * vitest**. Las suites de `packages/ports/src/testing/` están escritas sin
 * importar ningún runner —la regla `ports-are-pure` lo prohíbe— y hasta acá
 * nunca habían corrido: estaban tipadas y compiladas, nada más. Si
 * `{ describe, it }` de vitest no encajara en `ContractHarness`, las once
 * suites serían código muerto que parece cobertura.
 *
 * **Va con `systemClock`, no con `FixedClock`, y eso lo descubrió la suite.**
 * Montada con un reloj fijo en 2026-01-01 falló dos casos: el `expiresAt` de
 * las URLs firmadas quedaba en el pasado. Es un hallazgo correcto, no un
 * defecto de la suite: una URL firmada la consume un cliente externo que usa
 * la hora de pared, así que su vencimiento tiene que ser futuro contra ESA
 * hora, no contra el reloj inyectado. Un adaptador de storage con reloj
 * congelado firmaría URLs nacidas vencidas.
 */
describeStorageContract({ describe, it }, "memory", {
  makeAdapter: () => new MemoryStorage(systemClock),
  keyPrefix: "contract/memory",
});

describe("MemoryStorage — comportamiento propio del adaptador", () => {
  it("con reloj congelado en el pasado firma URLs ya vencidas", async () => {
    // El caso que la suite de contrato detectó. Queda fijado acá para que
    // nadie "arregle" el contrato relajando `checkFuture`: el problema está
    // en montar el adaptador con un reloj que no es el del cliente.
    const pasado = new FixedClock("2020-01-01T00:00:00.000Z");
    const storage = new MemoryStorage(pasado);

    const signed = await storage.createDownloadUrl({ key: "k", ttlSeconds: 60 });
    expect(signed.expiresAt.getTime()).toBeLessThan(Date.now());
  });

  it("delete es idempotente y no deja rastro", async () => {
    const storage = new MemoryStorage(systemClock);
    await storage.put({ key: "k", body: new Uint8Array([1]), contentType: "text/plain" });
    expect(storage.size).toBe(1);

    await storage.delete("k");
    await storage.delete("k"); // otra vez: no es error
    expect(storage.size).toBe(0);
  });
});
