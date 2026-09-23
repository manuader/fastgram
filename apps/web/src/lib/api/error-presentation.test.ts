/**
 * El test que importa acá es el primero: **una cuota agotada y un 500 no pueden
 * verse igual**. Ese es el requisito de §19 y es exactamente lo que se pierde cuando
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
    const quota = presentError(failure("content_quota_exceeded", 429));
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
  it("la cuota se reconoce por el `code`: un 429 de cuota NO es un rate limit", () => {
    // ERR-R01 y ERR-R03 comparten status. Hasta el 2026-09-23 la API mandaba
    // la cuota como 402 y "402 = cuota" parecía una regla; con el 429 correcto,
    // decidir por status ofrecería `Try again` sobre una cuota agotada.
    const quota = presentError(
      failure("content_quota_exceeded", 429, { count: 20, limit: 20, resetAt: 1 }),
    );
    const rate = presentError(failure("rate_limited", 429, { retryAfterMs: 1000 }));
    expect(quota.remedy).toBe("upgrade");
    expect(quota.titleKey).toBe("error.contentQuota.title");
    expect(rate.remedy).toBe("retry");
    // Y el status no pesa: el mismo código con cualquier status da lo mismo.
    expect(presentError(failure("content_quota_exceeded", 402)).remedy).toBe("upgrade");
    expect(presentError(failure("blitz_quota_exceeded", 429)).remedy).toBe("upgrade");
  });

  it("trial agotado (ERR-R04): sin `resetAt` pero con count/limit, copy de trial", () => {
    const shown = presentError(
      failure("content_quota_exceeded", 429, { count: 3, limit: 3 }),
    );
    expect(shown.titleKey).toBe("error.trialQuota.title");
    expect(shown.remedy).toBe("upgrade");
    expect(shown.descriptionKey).toBeUndefined();
  });

  it("sin `details` no se asume trial: la falta de datos no es evidencia", () => {
    const shown = presentError(failure("content_quota_exceeded", 429));
    expect(shown.titleKey).toBe("error.contentQuota.title");
  });

  it("el 429 de cuota publica cuándo vuelve, en UTC (§16.2)", () => {
    const resetAt = Date.UTC(2026, 9, 15);
    const shown = presentError(
      failure("content_quota_exceeded", 429, { count: 20, limit: 20, resetAt }),
    );
    expect(shown.descriptionKey).toBe("error.quota.resetsAt");
    expect(shown.vars).toEqual({ date: "Oct 15" });
  });

  it("sin `resetAt` no se inventa una fecha", () => {
    const shown = presentError(failure("content_quota_exceeded", 429));
    expect(shown.descriptionKey).toBeUndefined();
  });

  it("un `resetAt` que no es un instante se ignora", () => {
    // Llega como `Record<string, unknown>`: creerle produciría `Invalid Date`.
    expect(
      quotaResetAt(failure("content_quota_exceeded", 429, { resetAt: "soon" })),
    ).toBe(null);
    expect(quotaResetAt(failure("content_quota_exceeded", 429, { resetAt: -1 }))).toBe(
      null,
    );
    // El ISO que la API mandaba antes del 2026-09-23 tampoco es un instante acá.
    expect(
      quotaResetAt(
        failure("content_quota_exceeded", 429, { resetAt: "2026-10-15T00:00:00.000Z" }),
      ),
    ).toBe(null);
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

/**
 * §19.5.1 — los `ERR-B` viajan en `details.code`, con un código del cable que
 * por sí solo diría otra cosa. Cada caso de acá es uno donde leer sólo el
 * código del cable enseñaría el mensaje equivocado **o la salida equivocada**.
 */
describe("presentError · ERR-B de Brand Sources (§19.5.1)", () => {
  it("ERR-B10 (cap de 5) no es un genérico «request inválida»", () => {
    const shown = presentError(failure("bad_request", 400, { code: "ERR-B10", cap: 5 }));
    expect(shown.titleKey).toBe("error.brand.sourceLimit.title");
    expect(shown.remedy).toBe("none");
  });

  it("ERR-B11 llega como 429 y NO ofrece «Try again»: es un cooldown de horas", () => {
    // 61 min: se redondea hacia arriba. Decir «1 hour» manda a un 429 seguro.
    const shown = presentError(
      failure("rate_limited", 429, { code: "ERR-B11", retryAfterMs: 61 * 60_000 }),
    );
    expect(shown.titleKey).toBe("error.brand.refreshCooldown.title");
    expect(shown.titleVars).toEqual({ hours: "2" });
    expect(shown.remedy).toBe("none");
    // Sin el ERR-B, el mismo 429 sí sería reintentable.
    expect(presentError(failure("rate_limited", 429)).remedy).toBe("retry");
  });

  it("ERR-B06 usa el copy neutro, que no nombra el otro workspace", () => {
    const shown = presentError(
      failure("conflict", 409, { code: "ERR-B06", reason: "already_registered" }),
    );
    expect(shown.titleKey).toBe("error.brand.alreadyConnected.title");
    // `conflict` a secas diría «recargá», y recargar no cambia de dueño un perfil.
    expect(shown.remedy).toBe("none");
  });

  it("ERR-B03 lleva el handle que manda la API", () => {
    const shown = presentError(
      failure("bad_request", 400, {
        code: "ERR-B03",
        handle: "mimarca",
        candidates: ["instagram"],
        preselected: null,
      }),
    );
    expect(shown.titleKey).toBe("error.brand.whichPlatform.title");
    expect(shown.titleVars).toEqual({ handle: "mimarca" });
  });

  it("ERR-B07 traduce `sourceType` al nombre de la plataforma", () => {
    const shown = presentError(
      failure("service_unavailable", 503, { code: "ERR-B07", sourceType: "tiktok" }),
    );
    expect(shown.titleVars).toEqual({ platform: "TikTok" });
    expect(shown.remedy).toBe("retry");
  });

  it("un ERR-B sin los huecos que su copy exige cae al código del cable, no a llaves visibles", () => {
    const shown = presentError(failure("bad_request", 400, { code: "ERR-B03" }));
    expect(shown.titleKey).toBe("error.badRequest.title");
    expect(shown.titleVars).toBeUndefined();
  });

  it("un `details.code` que no es un ERR-B conocido no se interpreta", () => {
    const shown = presentError(failure("bad_request", 400, { code: "ERR-B99" }));
    expect(shown.titleKey).toBe("error.badRequest.title");
  });
});
