/**
 * La tabla de `DP-006`.
 *
 * Tres cosas que un test verde tiene que poder afirmar, y cada una se vio roja
 * con el mecanismo quitado antes de darla por buena (trampa 24):
 *  1. **Exhaustiva.** Cada motivo × cada plataforma tiene una celda, y se itera
 *     sobre las listas de runtime —`PUBLISH_PLATFORMS` viene del puerto— para
 *     que un valor nuevo rompa acá y no en producción.
 *  2. **No inventa.** Cada código y cada copy que puede salir están escritos,
 *     literales, en `PRD.md`.
 *  3. **No filtra.** El mensaje del proveedor entra y no sale.
 */
import { readFileSync } from "node:fs";

import { PUBLISH_PLATFORMS, type PublishFailureReason } from "@fastgram/ports";
import { describe, expect, it } from "vitest";

import {
  PUBLISH_ERROR_CODES,
  PUBLISH_ERROR_TABLE,
  PUBLISH_FAILURE_REASONS,
  translatePublishFailure,
  type PublishErrorTranslation,
} from "./error-code.js";

const PRD = readFileSync(new URL("../../../../PRD.md", import.meta.url), "utf8");

function traducir(
  reason: PublishFailureReason,
  platform: (typeof PUBLISH_PLATFORMS)[number],
  message = "Safe message",
): PublishErrorTranslation {
  return translatePublishFailure({ platform, failure: { reason, message } });
}

/** Todas las celdas, iterando las listas de runtime. */
const CELDAS = PUBLISH_FAILURE_REASONS.flatMap((reason) =>
  PUBLISH_PLATFORMS.map((platform) => ({ reason, platform })),
);

describe("exhaustividad", () => {
  it("la lista de motivos es exactamente el conjunto de filas de la tabla", () => {
    // La tabla es `Record<PublishFailureReason, …>`: el compilador la obliga a
    // tener todos los motivos del puerto. Esto ata la lista de runtime a ella.
    expect(Object.keys(PUBLISH_ERROR_TABLE).sort()).toEqual(
      [...PUBLISH_FAILURE_REASONS].sort(),
    );
  });

  it("cada fila tiene exactamente las plataformas del puerto", () => {
    for (const reason of PUBLISH_FAILURE_REASONS) {
      expect(Object.keys(PUBLISH_ERROR_TABLE[reason]).sort(), reason).toEqual(
        [...PUBLISH_PLATFORMS].sort(),
      );
    }
  });

  it.each(CELDAS)("$reason × $platform tiene salida definida", ({ reason, platform }) => {
    const out = traducir(reason, platform);
    expect(out).toBeDefined();
    expect(["coded", "uncoded", "escalate"]).toContain(out.kind);
    expect(out).toBe(PUBLISH_ERROR_TABLE[reason][platform]);
  });

  it(`son ${PUBLISH_FAILURE_REASONS.length} × ${PUBLISH_PLATFORMS.length} celdas`, () => {
    // Si alguien vacía una de las listas, el `it.each` de arriba pasa con cero
    // casos. Esto no.
    expect(CELDAS).toHaveLength(35);
  });
});

describe("no inventa códigos", () => {
  const emitidos = new Set(
    CELDAS.map(({ reason, platform }) => traducir(reason, platform))
      .filter((o) => o.kind === "coded")
      .map((o) => (o.kind === "coded" ? o.errorCode : "")),
  );

  it("todo código emitido está en PUBLISH_ERROR_CODES, y todo PUBLISH_ERROR_CODES se emite", () => {
    expect([...emitidos].sort()).toEqual([...PUBLISH_ERROR_CODES].sort());
  });

  it.each(PUBLISH_ERROR_CODES)("`%s` está literal en PRD.md", (code) => {
    expect(PRD).toContain(`\`${code}\``);
  });

  it("toda copy devuelta está literal en PRD.md", () => {
    const copias = CELDAS.flatMap(({ reason, platform }) => {
      const out = traducir(reason, platform);
      if (out.kind === "escalate" || out.copy === null) return [];
      return [out.copy.title, out.copy.body].filter((x) => x !== undefined);
    });
    expect(copias.length).toBeGreaterThan(0);
    for (const c of copias) expect(PRD, c).toContain(c);
  });

  it("los códigos con prefijo de plataforma son plataforma + motivo, y de esa plataforma", () => {
    // El puerto dice que `instagram_repeated_mention` «se compone como
    // plataforma + `repeated_mention`». Una celda que pusiera el código de
    // TikTok en la fila de YouTube pasaría el chequeo de «está en el PRD».
    for (const { reason, platform } of CELDAS) {
      const out = traducir(reason, platform);
      if (out.kind !== "coded" || out.errorCode === "rate_limited") continue;
      expect(out.errorCode).toBe(`${platform}_${reason}`);
    }
  });

  it("los casos que el PRD fija a mano (FR-060, INT-001/002/003, ERR-R05)", () => {
    // Elegidos a mano y no derivados de la tabla (trampa 36).
    const esperado = (errorCode: string) =>
      expect.objectContaining({ kind: "coded", errorCode });
    expect(traducir("post_limit_exceeded", "tiktok")).toEqual(
      esperado("tiktok_post_limit_exceeded"),
    );
    expect(traducir("post_limit_exceeded", "instagram")).toEqual(
      esperado("instagram_post_limit_exceeded"),
    );
    expect(traducir("post_limit_exceeded", "youtube")).toEqual(
      esperado("youtube_post_limit_exceeded"),
    );
    expect(traducir("repeated_mention", "instagram")).toEqual(
      esperado("instagram_repeated_mention"),
    );
    // Sin código diferenciado en el PRD: el genérico de FR-060.
    expect(traducir("post_limit_exceeded", "linkedin")).toEqual(esperado("rate_limited"));
    expect(traducir("post_limit_exceeded", "reddit")).toEqual(esperado("rate_limited"));
  });

  it("`repeated_mention` fuera de Instagram no fabrica `<plataforma>_repeated_mention`", () => {
    for (const platform of PUBLISH_PLATFORMS.filter((p) => p !== "instagram")) {
      expect(traducir("repeated_mention", platform)).toEqual({
        kind: "uncoded",
        catalogRef: null,
        copy: null,
      });
    }
  });
});

describe("tabla primero, juicio sólo para lo que no matchea (DP-006)", () => {
  it("sólo `unknown` escala a Judgment", () => {
    for (const { reason, platform } of CELDAS) {
      const out = traducir(reason, platform);
      expect(out.kind === "escalate", `${reason} × ${platform}`).toBe(
        reason === "unknown",
      );
    }
  });

  it("un `escalate` nombra el punto de decisión", () => {
    expect(traducir("unknown", "tiktok")).toEqual({
      kind: "escalate",
      decisionPoint: "DP-006",
    });
  });

  it("un motivo o una plataforma fuera de la tabla escalan, no lanzan", () => {
    // Llegan como `string` de un adaptador más nuevo o de una fila vieja.
    const motivoNuevo = translatePublishFailure({
      platform: "tiktok",
      failure: { reason: "shadow_banned" as PublishFailureReason, message: "x" },
    });
    expect(motivoNuevo.kind).toBe("escalate");

    const plataformaNueva = translatePublishFailure({
      platform: "threads" as (typeof PUBLISH_PLATFORMS)[number],
      failure: { reason: "post_limit_exceeded", message: "x" },
    });
    expect(plataformaNueva.kind).toBe("escalate");

    // Claves heredadas de `Object.prototype` no son celdas.
    const heredada = translatePublishFailure({
      platform: "tiktok",
      failure: { reason: "toString" as PublishFailureReason, message: "x" },
    });
    expect(heredada.kind).toBe("escalate");

    // Y del lado de la plataforma: sin `hasOwn`, `row["constructor"]` es
    // `Object` y saldría como si fuera una traducción.
    const heredadaPlataforma = translatePublishFailure({
      platform: "constructor" as (typeof PUBLISH_PLATFORMS)[number],
      failure: { reason: "post_limit_exceeded", message: "x" },
    });
    expect(heredadaPlataforma).toEqual({ kind: "escalate", decisionPoint: "DP-006" });
  });

  it("ERR-D16 no lleva la copy que afirma que el post fue al inbox", () => {
    // La tabla se consulta sobre un `failed`; decir «Your post was sent to your
    // inbox instead» sería falso.
    const out = traducir("privacy_level_not_allowed", "tiktok");
    expect(out).toEqual({ kind: "uncoded", catalogRef: "ERR-D16", copy: null });
  });
});

describe("no filtra el mensaje del proveedor", () => {
  const CRUDO =
    "TikTok API error spam_risk_too_many_posts: log_id 20260923ab12 (Ayrshare code 137)";
  const FRAGMENTOS = [
    "spam_risk",
    "log_id",
    "20260923ab12",
    "Ayrshare",
    "137",
    "TikTok API",
  ];

  it.each(CELDAS)("$reason × $platform", ({ reason, platform }) => {
    const out = traducir(reason, platform, CRUDO);
    const serializado = JSON.stringify(out);
    // Negativa primero (trampa 35): lo que importa es que NO aparezca.
    for (const f of FRAGMENTOS) expect(serializado).not.toContain(f);
    // Y el mensaje no influye: misma salida con otro mensaje.
    expect(out).toEqual(traducir(reason, platform, "otra cosa"));
  });
});

describe("pureza", () => {
  it("devuelve siempre el mismo objeto, congelado", () => {
    const a = traducir("account_changed", "instagram");
    const b = traducir("account_changed", "instagram");
    expect(a).toBe(b);
    expect(Object.isFrozen(a)).toBe(true);
    if (a.kind === "escalate" || a.copy === null) throw new Error("se esperaba copy");
    expect(Object.isFrozen(a.copy)).toBe(true);
  });

  it("mutar una salida no altera la tabla", () => {
    const out = traducir("post_limit_exceeded", "tiktok") as { errorCode: string };
    expect(() => {
      out.errorCode = "otra";
    }).toThrow(TypeError);
    expect(traducir("post_limit_exceeded", "tiktok")).toEqual(
      expect.objectContaining({ errorCode: "tiktok_post_limit_exceeded" }),
    );
  });
});
