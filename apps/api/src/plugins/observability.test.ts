/**
 * La redacción de pino sobre las credenciales. Las rutas no loguean headers
 * (el serializador de request de Fastify no los incluye), así que esto es la
 * red para el día que alguien loguee la petición entera: se prueba acá porque
 * ningún camino de la app la ejercita.
 */
import { describe, expect, it } from "vitest";
import pino from "pino";

import { REDACTED_PATHS } from "./observability.js";

describe("REDACTED_PATHS", () => {
  it("tacha Authorization, cookie y X-Fastgram-Session", () => {
    const lines: string[] = [];
    const log = pino(
      { redact: { paths: [...REDACTED_PATHS], remove: true } },
      { write: (line: string) => void lines.push(line) },
    );
    log.info(
      {
        req: {
          headers: {
            authorization: "Bearer fsln_live_SECRETO1",
            cookie: "a=SECRETO2",
            "x-fastgram-session": "SECRETO3.firma",
            "x-request-id": "visible",
          },
        },
      },
      "petición entera",
    );
    const out = lines.join("");
    expect(out).toContain("visible");
    for (const secret of ["SECRETO1", "SECRETO2", "SECRETO3"]) {
      expect(out).not.toContain(secret);
    }
  });
});
