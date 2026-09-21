/**
 * Armazón de las suites de contrato de puerto — IMPL §4.
 *
 * «**Una sola suite corre contra todos los adaptadores de un puerto.** Es lo
 * que hace que cambiar de proveedor sea creíble.» Esa frase es la razón de
 * existir de este directorio: sin una suite compartida, «el adaptador de R2 y
 * el de MinIO hacen lo mismo» es una creencia, no un hecho verificado.
 *
 * **Por qué no se importa `vitest` acá.** La regla `ports-are-pure` de
 * `.dependency-cruiser.cjs` prohíbe que `packages/ports/src` importe cualquier
 * cosa de npm, y con razón: «un puerto que importa el SDK que pretende
 * abstraer deja de ser una abstracción». `vitest` no es un SDK de proveedor,
 * pero la regla no distingue y tampoco debería: el día que estas suites corran
 * desde un runner distinto, o desde un script de validación de adaptador en
 * producción, no tendrían por qué arrastrar un framework de test.
 *
 * Así que el runner entra por parámetro ({@link ContractHarness}) y las
 * aserciones son propias ({@link check} y compañía). Quien monta la suite
 * escribe, en su archivo `.test.ts` —que sí puede importar vitest porque
 * `options.exclude` del dependency-cruiser lo excluye—:
 *
 * ```ts
 * import { describe, it } from "vitest";
 * describeStorageContract({ describe, it }, "r2", { makeAdapter: () => new R2Storage(cfg) });
 * ```
 */

import { isPortError, type PortErrorCode } from "../errors.js";

/**
 * Lo mínimo de un runner. `expect` no entra a propósito: su tipo varía entre
 * runners y atarlo acá volvería a acoplar el puerto a una herramienta.
 */
export interface ContractHarness {
  readonly describe: (name: string, body: () => void) => void;
  readonly it: (name: string, body: () => void | Promise<void>) => void;
}

/** Fábrica del adaptador bajo prueba. Se invoca una vez por caso. */
export type AdapterFactory<T> = () => T | Promise<T>;

/** Un incumplimiento del contrato del puerto, no un error del adaptador. */
export class ContractViolation extends Error {
  override readonly name = "ContractViolation";
}

export function check(condition: boolean, message: string): void {
  if (!condition) throw new ContractViolation(message);
}

export function checkEqual<T>(actual: T, expected: T, message: string): void {
  if (actual !== expected) {
    throw new ContractViolation(
      `${message} — esperado ${String(expected)}, vino ${String(actual)}`,
    );
  }
}

export function checkInRange(
  value: number,
  min: number,
  max: number,
  message: string,
): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new ContractViolation(
      `${message} — ${String(value)} fuera de [${min}, ${max}]`,
    );
  }
}

/** Tolerancia de punto flotante para distribuciones de probabilidad. */
const SUM_TOLERANCE = 1e-3;

export function checkSumsToOne(values: readonly number[], message: string): void {
  let total = 0;
  for (const value of values) {
    checkInRange(value, 0, 1, `${message}: cada probabilidad`);
    total += value;
  }
  if (Math.abs(total - 1) > SUM_TOLERANCE) {
    throw new ContractViolation(
      `${message} — la distribución suma ${String(total)}, no 1`,
    );
  }
}

/**
 * Afirma que la llamada falla con un `PortError` de uno de estos códigos.
 *
 * Es la aserción más importante del paquete: el contrato público del PRD
 * devuelve códigos neutrales (§9.3, `NFR-022`), y un adaptador que deje
 * escapar el error crudo del proveedor rompe a todos los integradores. Que
 * falle no alcanza: tiene que fallar **con el código que el puerto promete**.
 */
export async function checkRejectsWithCode(
  body: () => Promise<unknown>,
  codes: readonly PortErrorCode[],
  message: string,
): Promise<void> {
  let thrown: unknown;
  let resolved = false;
  try {
    await body();
    resolved = true;
  } catch (error) {
    thrown = error;
  }
  if (resolved) {
    throw new ContractViolation(`${message} — no lanzó nada`);
  }
  if (!isPortError(thrown)) {
    throw new ContractViolation(
      `${message} — lanzó algo que no es PortError: ${String(thrown)}`,
    );
  }
  if (!codes.includes(thrown.code)) {
    throw new ContractViolation(
      `${message} — código ${thrown.code}, se esperaba uno de ${codes.join(" | ")}`,
    );
  }
}

/** Que una llamada no lance. Envuelve el error para que el mensaje sirva. */
export async function checkResolves<T>(
  body: () => Promise<T>,
  message: string,
): Promise<T> {
  try {
    return await body();
  } catch (error) {
    throw new ContractViolation(`${message} — lanzó ${String(error)}`);
  }
}

export function checkNonEmpty(value: string, message: string): void {
  check(value.length > 0, `${message} — vino vacío`);
}

export function checkFuture(value: Date, message: string): void {
  check(value.getTime() > Date.now(), `${message} — ${value.toISOString()} ya pasó`);
}
