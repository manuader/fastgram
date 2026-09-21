/**
 * El parseo del payload de `content-build`.
 *
 * Esto existe porque el payload vuelve de la cola como `unknown`: viajó por
 * JSON en una tabla de Postgres, lo escribió otro proceso y posiblemente otra
 * versión del código. Un `as` ahí es una mentira que el compilador no puede
 * desmentir, y el modo de falla no es un crash: es un `WHERE id = 'undefined'`
 * que no encuentra nada y hace concluir al handler que la pieza se borró.
 */
import { describe, expect, it } from "vitest";

import { parseContentBuildJob } from "./content-build.js";

const VALIDO = {
  companyId: "c0000000-0000-4000-8000-000000000000",
  contentId: "d0000000-0000-4000-8000-000000000000",
  contentType: "wall-of-text",
  revision: 1,
};

describe("parseContentBuildJob", () => {
  it("acepta el núcleo de cuatro campos", () => {
    const out = parseContentBuildJob(VALIDO);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.contentId).toBe(VALIDO.contentId);
    expect(out.payload.revision).toBe(1);
  });

  it("acepta el payload de Blitz, con `suggestionId`", () => {
    const out = parseContentBuildJob({
      ...VALIDO,
      contentType: "slideshow",
      suggestionId: "s-1",
      influencerId: "i-1",
      aspectRatio: "4:5",
      reason: "blitz",
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.suggestionId).toBe("s-1");
  });

  it("acepta el payload de `POST /content`, con `reason` y `prompt`", () => {
    // Los dos productores tenían formas distintas y ningún consumidor que
    // reconociera a los dos. El punto entero de este parser es aceptar ambas.
    const out = parseContentBuildJob({
      ...VALIDO,
      reason: "regenerate",
      prompt: "más corto",
      mentionBusiness: true,
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.reason).toBe("regenerate");
    expect(out.payload.mentionBusiness).toBe(true);
  });

  it("acepta `custom`, que no es un tipo de Blitz", () => {
    expect(parseContentBuildJob({ ...VALIDO, contentType: "custom" }).ok).toBe(true);
  });

  it("rechaza un `contentType` que no existe", () => {
    const out = parseContentBuildJob({ ...VALIDO, contentType: "carousel" });
    expect(out.ok).toBe(false);
  });

  it("rechaza un `contentId` ausente", () => {
    const { contentId: _omitido, ...sinId } = VALIDO;
    const out = parseContentBuildJob(sinId);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("contentId");
  });

  it("rechaza una cadena vacía, que un `typeof === string` dejaría pasar", () => {
    expect(parseContentBuildJob({ ...VALIDO, companyId: "" }).ok).toBe(false);
  });

  it("rechaza una `revision` que no es entero", () => {
    // Un `revision` fraccionario o `NaN` **nunca** coincide con el de la fila,
    // así que el handler descartaría todos los builds en silencio creyendo que
    // el job es viejo. Es el peor modo de falla posible acá.
    expect(parseContentBuildJob({ ...VALIDO, revision: 1.5 }).ok).toBe(false);
    expect(parseContentBuildJob({ ...VALIDO, revision: Number.NaN }).ok).toBe(false);
    expect(parseContentBuildJob({ ...VALIDO, revision: "1" }).ok).toBe(false);
  });

  it("rechaza una `revision` menor que 1, que la base no permite", () => {
    expect(parseContentBuildJob({ ...VALIDO, revision: 0 }).ok).toBe(false);
  });

  it("rechaza lo que no es un objeto", () => {
    expect(parseContentBuildJob(null).ok).toBe(false);
    expect(parseContentBuildJob("content-build").ok).toBe(false);
    expect(parseContentBuildJob(undefined).ok).toBe(false);
  });

  it("trata `null` en un opcional como ausente", () => {
    // Importa porque el payload viaja por JSONB: un campo que el productor dejó
    // en `undefined` puede volver como `null` según cómo se serialice.
    const out = parseContentBuildJob({ ...VALIDO, prompt: null, influencerId: null });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.prompt).toBeUndefined();
  });

  it("rechaza un `reason` desconocido", () => {
    expect(parseContentBuildJob({ ...VALIDO, reason: "porque-si" }).ok).toBe(false);
  });
});
