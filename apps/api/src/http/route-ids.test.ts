import type { FastifyReply, FastifyRequest } from "fastify";
import { describe, expect, it } from "vitest";

import {
  NONEXISTENT_ID,
  isIdParam,
  isUuid,
  neutralizeMalformedIds,
} from "./route-ids.js";

function requestWith(params: Record<string, unknown>): {
  request: FastifyRequest;
  logged: unknown[];
} {
  const logged: unknown[] = [];
  const request = {
    params,
    log: { info: (obj: unknown) => logged.push(obj) },
  } as unknown as FastifyRequest;
  return { request, logged };
}

const reply = {} as FastifyReply;

describe("neutralizeMalformedIds", () => {
  it("un id que no es uuid pasa a ser el uuid nulo", async () => {
    const { request } = requestWith({ id: "no-soy-un-uuid" });
    await neutralizeMalformedIds(request, reply);
    expect(request.params).toEqual({ id: NONEXISTENT_ID });
  });

  it("un uuid válido no se toca, en mayúsculas tampoco", async () => {
    const id = "3F2504E0-4F89-41D3-9A0C-0305E82C3301";
    const { request, logged } = requestWith({ id });
    await neutralizeMalformedIds(request, reply);
    expect(request.params).toEqual({ id });
    expect(logged).toEqual([]);
  });

  it("un parámetro que no es un id no se toca", async () => {
    const { request } = requestWith({ platform: "tiktok", slug: "x" });
    await neutralizeMalformedIds(request, reply);
    expect(request.params).toEqual({ platform: "tiktok", slug: "x" });
  });

  it("el log dice qué parámetro, nunca el valor que mandó el cliente", async () => {
    const { request, logged } = requestWith({ contentId: "1' or '1'='1" });
    await neutralizeMalformedIds(request, reply);
    expect(JSON.stringify(logged)).not.toContain("or '1'");
    expect(logged).toEqual([{ param: "contentId", reason: "malformed_id" }]);
  });
});

describe("isIdParam / isUuid", () => {
  it("reconoce `id` y `fooId`, no `valid` ni `Id`", () => {
    expect(["id", "contentId", "valid", "Id", "slug"].map(isIdParam)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  it("el uuid nulo es un uuid bien formado", () => {
    expect(isUuid(NONEXISTENT_ID)).toBe(true);
    expect(isUuid("")).toBe(false);
  });
});
