/**
 * Contrato del puerto `Queue` — IMPL ADR-005 e IMPL §2.3, PRD §9.5, `NFR-004`.
 *
 * El caso central es `singletonKey`. IMPL §2.3 explica que la cola vive en
 * Postgres para poder encolar dentro de la transacción de negocio, y `NFR-015`
 * prohíbe duplicar un post en el carril lento de TikTok. Si un adaptador
 * ignorara `singletonKey`, el sistema seguiría pareciendo sano hasta el día en
 * que un reintento publique dos veces en la cuenta de un cliente.
 *
 * **Lo que esta suite no puede verificar** y hay que dejar anotado: la
 * atomicidad de `enqueue` con `transaction`. Comprobarla exige abrir una
 * transacción real, encolar, hacer rollback y verificar que el job no quedó —
 * y eso necesita la base, o sea un test de integración con Testcontainers
 * (IMPL §4), no una suite de contrato en memoria. Es la garantía más
 * importante del puerto y la única que queda fuera de acá.
 */

import type { Queue } from "../queue.js";
import {
  check,
  checkEqual,
  checkNonEmpty,
  checkRejectsWithCode,
  checkResolves,
  type AdapterFactory,
  type ContractHarness,
} from "./harness.js";

export interface QueueContractSetup {
  readonly makeAdapter: AdapterFactory<Queue>;
  /** Nombre de cola exclusivo de la corrida, para no mezclar con trabajo real. */
  readonly queueName: string;
}

interface SamplePayload {
  readonly contentId: string;
}

export function describeQueueContract(
  harness: ContractHarness,
  name: string,
  setup: QueueContractSetup,
): void {
  const { describe, it } = harness;
  const queue = setup.queueName;
  let counter = 0;
  const nextKey = (): string => {
    counter += 1;
    return `${queue}-${String(counter)}-${String(Date.now())}`;
  };

  describe(`Queue contract · ${name}`, () => {
    it("enqueue devuelve un id y el job queda consultable con su payload", async () => {
      const adapter = await setup.makeAdapter();
      const payload: SamplePayload = { contentId: "c-1" };
      const enqueued = await adapter.enqueue({ queue, payload });

      checkNonEmpty(enqueued.jobId, "jobId");
      checkEqual(enqueued.created, true, "created en el primer encolado");

      const status = await adapter.getJob<SamplePayload>(enqueued.jobId);
      check(status !== null, "getJob devolvió null para un job recién encolado");
      if (status === null) return;
      checkEqual(status.queue, queue, "cola del job");
      checkEqual(status.payload.contentId, "c-1", "payload del job");
      check(
        status.state === "queued" || status.state === "active",
        `estado inicial inesperado: ${status.state}`,
      );
    });

    it("singletonKey no duplica: el segundo encolado devuelve el mismo job", async () => {
      const adapter = await setup.makeAdapter();
      const singletonKey = nextKey();
      const first = await adapter.enqueue({
        queue,
        payload: { contentId: "c-2" },
        options: { singletonKey },
      });
      const second = await adapter.enqueue({
        queue,
        payload: { contentId: "c-2" },
        options: { singletonKey },
      });

      checkEqual(second.created, false, "created en el encolado repetido");
      checkEqual(
        second.jobId,
        first.jobId,
        "misma singletonKey tiene que devolver el job original (NFR-004)",
      );
    });

    it("getJob de un id desconocido devuelve null", async () => {
      const adapter = await setup.makeAdapter();
      checkEqual(
        await adapter.getJob("00000000-0000-0000-0000-000000000000"),
        null,
        "getJob de id desconocido",
      );
    });

    it("cancel funciona una vez y la segunda devuelve false", async () => {
      const adapter = await setup.makeAdapter();
      const enqueued = await adapter.enqueue({
        queue,
        payload: { contentId: "c-3" },
        // Lejos en el futuro para que no arranque mientras se lo cancela.
        options: { startAfter: new Date(Date.now() + 3_600_000) },
      });

      checkEqual(await adapter.cancel(enqueued.jobId), true, "primera cancelación");
      checkEqual(
        await adapter.cancel(enqueued.jobId),
        false,
        "segunda cancelación: FR-060 depende de distinguir cancelado de cancelable",
      );

      const status = await adapter.getJob(enqueued.jobId);
      check(status !== null, "getJob después de cancelar");
      if (status === null) return;
      checkEqual(status.state, "cancelled", "estado después de cancelar");
    });

    it("enqueueMany encola todo el lote", async () => {
      const adapter = await setup.makeAdapter();
      const results = await adapter.enqueueMany([
        { queue, payload: { contentId: "fan-1" } },
        { queue, payload: { contentId: "fan-2" } },
        { queue, payload: { contentId: "fan-3" } },
      ]);
      checkEqual(results.length, 3, "jobs devueltos por enqueueMany");
      for (const result of results) {
        checkNonEmpty(result.jobId, "jobId del lote");
      }
    });

    it("scheduleRecurring rechaza un cron inválido", async () => {
      const adapter = await setup.makeAdapter();
      await checkRejectsWithCode(
        () =>
          adapter.scheduleRecurring({
            name: nextKey(),
            queue,
            cron: "no soy un cron",
            payload: {},
          }),
        ["bad_request"],
        "cron inválido",
      );
    });

    it("stop es idempotente: apagar dos veces no rompe", async () => {
      const adapter = await setup.makeAdapter();
      await adapter.start();
      await adapter.stop();
      await checkResolves(() => adapter.stop(), "segundo stop");
    });
  });
}
