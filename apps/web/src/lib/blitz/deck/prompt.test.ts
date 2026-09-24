/**
 * «Create from prompt», la lógica pura · `PU-BLITZ-003`. Corre en Node.
 */
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../../api/errors";
import {
  PROMPT_COUNTS,
  PROMPT_POLL_MS,
  promptFailureView,
  promptInputError,
  promptPollInterval,
  promptStatusSchema,
} from "./prompt";

const status = (s: "queued" | "running" | "done" | "failed") =>
  promptStatusSchema.parse({ requestId: "r1", status: s, suggestionIds: [] });

describe("promptPollInterval", () => {
  it("pregunta mientras el pedido está abierto, o todavía no se sabe", () => {
    expect(promptPollInterval(undefined, null)).toBe(PROMPT_POLL_MS);
    expect(promptPollInterval(status("queued"), null)).toBe(PROMPT_POLL_MS);
    expect(promptPollInterval(status("running"), null)).toBe(PROMPT_POLL_MS);
  });

  it("para al cerrar, y ante un error (un 404 no va a cambiar solo)", () => {
    expect(promptPollInterval(status("done"), null)).toBe(false);
    expect(promptPollInterval(status("failed"), null)).toBe(false);
    expect(
      promptPollInterval(
        undefined,
        new ApiRequestError({ code: "not_found", status: 404 }),
      ),
    ).toBe(false);
  });
});

describe("promptFailureView — cada código con su arreglo", () => {
  it("sin LLM y LLM caído → Settings → Models", () => {
    expect(promptFailureView("llm_not_configured").link?.href).toBe("/settings/models");
    expect(promptFailureView("llm_failed").link?.href).toBe("/settings/models");
  });

  it("sin media → Library", () => {
    expect(promptFailureView("no_media_for_format")).toEqual({
      message: "prompt.failed.noMediaForFormat",
      link: { href: "/library", label: "prompt.failed.mediaLink" },
    });
    expect(promptFailureView("no_media").link?.href).toBe("/library");
  });

  it("un código desconocido o ausente → mensaje genérico, sin link inventado", () => {
    expect(promptFailureView("algo_nuevo")).toEqual({ message: "prompt.failed.generic" });
    expect(promptFailureView(undefined)).toEqual({ message: "prompt.failed.generic" });
  });
});

describe("promptInputError — el mismo 3–500 de la API, después de recortar", () => {
  it("valida", () => {
    expect(promptInputError("  ab  ")).toBe("prompt.tooShort");
    expect(promptInputError("abc")).toBeNull();
    expect(promptInputError("x".repeat(500))).toBeNull();
    expect(promptInputError("x".repeat(501))).toBe("prompt.tooLong");
  });

  it("el selector ofrece 1…5", () => {
    expect(PROMPT_COUNTS).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("promptStatusSchema es tolerante con el motivo", () => {
  it("un código que el cliente no conoce no es un invalid_response", () => {
    const parsed = promptStatusSchema.parse({
      requestId: "r1",
      status: "failed",
      suggestionIds: [],
      failureReason: "codigo_del_futuro",
    });
    expect(parsed.failureReason).toBe("codigo_del_futuro");
  });
});
