import { describe, expect, it } from "vitest";
import {
  EnvError,
  baseEnvSchema,
  defineEnv,
  postgresEnvSchema,
  storageEnvSchema,
  z,
} from "./env.js";

/**
 * La promesa de `P0-REPO-009` es: **si falta una variable requerida, el
 * proceso no levanta.** Estaba escrita en el código y en el `.env.example`,
 * pero no tenía test — o sea que era una intención, no una garantía.
 *
 * Lo que más importa acá no es que lance: es **qué dice cuando lanza**. Un
 * error que no nombra la variable que falta manda a alguien a leer código a
 * las tres de la mañana.
 */
describe("defineEnv", () => {
  it("devuelve la configuración cuando está completa", () => {
    const env = defineEnv("test", postgresEnvSchema, {
      DATABASE_URL: "postgres://u:p@localhost:5432/db",
    });
    expect(env.DATABASE_URL).toBe("postgres://u:p@localhost:5432/db");
  });

  it("lanza si falta una requerida", () => {
    expect(() => defineEnv("api", postgresEnvSchema, {})).toThrow(EnvError);
  });

  it("el error NOMBRA la variable que falta y la app que la pide", () => {
    try {
      defineEnv("worker", storageEnvSchema, { S3_BUCKET: "b" });
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      expect(e).toBeInstanceOf(EnvError);
      const err = e as EnvError;
      expect(err.appName).toBe("worker");

      // Todas las que faltan, no sólo la primera: si reportara de a una,
      // arrancar el stack sería un juego de adivinanzas de cinco rondas.
      const faltantes = err.issues.map((i) => i.path);
      expect(faltantes).toContain("S3_ENDPOINT");
      expect(faltantes).toContain("S3_ACCESS_KEY_ID");
      expect(faltantes).toContain("S3_SECRET_ACCESS_KEY");
      expect(faltantes).toContain("S3_PUBLIC_URL");

      expect(err.message).toContain("worker");
      expect(err.message).toContain("S3_ENDPOINT");
      expect(err.message).toContain(".env.example");
    }
  });

  it("rechaza una URL de base que no es postgres", () => {
    // Apuntar a MySQL por accidente falla acá y no en la primera consulta.
    expect(() =>
      defineEnv("api", postgresEnvSchema, { DATABASE_URL: "mysql://u:p@h/db" }),
    ).toThrow(EnvError);
  });

  it("rechaza algo que ni siquiera es una URL", () => {
    expect(() =>
      defineEnv("api", postgresEnvSchema, { DATABASE_URL: "localhost:5432" }),
    ).toThrow(EnvError);
  });

  it("aplica los defaults declarados", () => {
    const env = defineEnv("api", baseEnvSchema, {});
    expect(env.NODE_ENV).toBe("development");
    expect(env.LOG_LEVEL).toBe("info");
  });

  it("rechaza un NODE_ENV inventado", () => {
    // `staging` es tentador y no está en el enum: mejor frenarlo al arrancar
    // que descubrir en producción que una rama `if (NODE_ENV === "production")`
    // nunca se tomó.
    expect(() => defineEnv("api", baseEnvSchema, { NODE_ENV: "staging" })).toThrow(
      EnvError,
    );
  });

  it("el mensaje lista TODOS los problemas de una sola vez", () => {
    const schema = baseEnvSchema.merge(postgresEnvSchema);
    try {
      defineEnv("api", schema, { NODE_ENV: "nope" });
      expect.unreachable("tenía que lanzar");
    } catch (e) {
      const err = e as EnvError;
      expect(err.issues.length).toBeGreaterThanOrEqual(2);
    }
  });

  it("no mira `process.env` cuando se le pasa una fuente", () => {
    // Sin esto, los tests dependerían del entorno de quien los corre y
    // pasarían o fallarían según la máquina.
    const schema = z.object({ SOLO_EN_TEST: z.string() });
    expect(() => defineEnv("x", schema, {})).toThrow(EnvError);
    expect(defineEnv("x", schema, { SOLO_EN_TEST: "v" }).SOLO_EN_TEST).toBe("v");
  });
});
