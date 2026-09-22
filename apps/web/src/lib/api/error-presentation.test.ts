/**
 * El test que importa acá es el primero: **un 402 y un 500 no pueden verse
 * igual**. Ese es el requisito de §19 y es exactamente lo que se pierde cuando
 * una pantalla pone `<ErrorState onRetry={refetch}/>` para todo.
 */
import { describe, expect, it } from "vitest";
import { ApiRequestError, FAILURE_COPY_KEYS, type FailureCode } from "./errors";
import { presentError, quotaResetAt, REMEDY_LABEL_KEY } from "./error-presentation";

const failure = (
  code: FailureCode,
  status: number,
  details?: Record<string, unknown>,
): ApiRequestError =>
  new ApiRequestError({ code, status, ...(details === undefined ? {} : { details }) });

describe("presentError", () => {
  it("cuota agotada y fallo del servidor NO ofrecen la misma salida", () => {
    const quota = presentError(failure("content_quota_exceeded", 402));
    const boom = presentError(failure("service_unavailable", 503));

    expect(quota.remedy).toBe("upgrade");
    expect(boom.remedy).toBe("retry");
    expect(quota.remedy).not.toBe(boom.remedy);
    // Y tampoco el mismo título: ERR-R03 tiene copy propia (PRD:3213).
    expect(quota.titleKey).not.toBe(boom.titleKey);
  });

  /**
   * La fecha se formatea **en UTC**, que es donde el PRD define el reset
   * (§16.2). Este test corrió en rojo primero, con `Oct 14`: el formateador
   * usaba la zona de la máquina y el instante es 00:00 UTC, así que al oeste de
   * Greenwich la fecha se corría un día. Es un fallo que en CI (UTC) no se ve.
   */
  it("el 402 publica cuándo vuelve la cuota, en UTC (§16.2)", () => {
    const resetAt = Date.UTC(2026, 9, 15);
    const shown = presentError(failure("content_quota_exceeded", 402, { resetAt }));
    expect(shown.descriptionKey).toBe("error.quota.resetsAt");
    expect(shown.vars).toEqual({ date: "Oct 15" });
  });

  it("sin `resetAt` no se inventa una fecha", () => {
    const shown = presentError(failure("content_quota_exceeded", 402));
    expect(shown.descriptionKey).toBeUndefined();
  });

  it("un `resetAt` que no es un instante se ignora", () => {
    // Llega como `Record<string, unknown>`: creerle produciría `Invalid Date`.
    expect(
      quotaResetAt(failure("content_quota_exceeded", 402, { resetAt: "soon" })),
    ).toBe(null);
    expect(quotaResetAt(failure("content_quota_exceeded", 402, { resetAt: -1 }))).toBe(
      null,
    );
  });

  it("`stale_revision` manda a recargar, no a reintentar (ERR-P04)", () => {
    expect(presentError(failure("stale_revision", 409)).remedy).toBe("reload");
  });

  it("un 401 no ofrece nada: reintentar no autentica a nadie", () => {
    expect(presentError(failure("unauthorized", 401)).remedy).toBe("none");
  });

  it("un error que no es del API cae al genérico reintentable", () => {
    const shown = presentError(new Error("boom"));
    expect(shown.titleKey).toBe("common.somethingWentWrong");
    expect(shown.remedy).toBe("retry");
  });

  /**
   * La red de seguridad: el día que `packages/contracts` agregue un código, el
   * `Record` de `error-presentation.ts` deja de compilar. Este test cubre el
   * caso en que alguien lo "arregle" con un valor cualquiera y se olvide de
   * darle label a una salida.
   */
  it("todos los códigos del contrato tienen salida, y toda salida tiene label", () => {
    for (const code of Object.keys(FAILURE_COPY_KEYS) as FailureCode[]) {
      const shown = presentError(failure(code, 500));
      expect(shown.remedy, code).toBeDefined();
      expect(REMEDY_LABEL_KEY, code).toHaveProperty(shown.remedy);
    }
  });
});
