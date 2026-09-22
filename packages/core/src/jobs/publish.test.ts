/**
 * El parseo del payload de `publishing`.
 *
 * Chico, pero no prescindible: el payload vuelve de la cola como `unknown` y un
 * `as` ahí termina en un `WHERE id = 'undefined'` que **no falla** — no
 * encuentra nada, y el handler concluye que el post se borró. Publicar es la
 * operación que no se puede deshacer, así que el silencio es el peor resultado.
 */
import { describe, expect, it } from "vitest";

import { parsePublishJob } from "./publish.js";

const VALIDO = {
  companyId: "c0000000-0000-4000-8000-000000000000",
  postId: "p0000000-0000-4000-8000-000000000000",
};

describe("parsePublishJob", () => {
  it("acepta el payload que encola la ruta", () => {
    const out = parsePublishJob(VALIDO);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.payload.postId).toBe(VALIDO.postId);
  });

  it("ignora los campos de más en vez de rechazarlos", () => {
    // Un productor de otra versión puede mandar más de lo que este consumidor
    // conoce. Rechazarlo convertiría un despliegue escalonado en posts que no
    // salen.
    const out = parsePublishJob({ ...VALIDO, contentId: "x", intento: 3 });
    expect(out.ok).toBe(true);
  });

  it("rechaza un `postId` ausente", () => {
    const { postId: _omitido, ...sinId } = VALIDO;
    const out = parsePublishJob(sinId);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toContain("postId");
  });

  it("rechaza una cadena vacía, que un `typeof === string` dejaría pasar", () => {
    expect(parsePublishJob({ ...VALIDO, companyId: "" }).ok).toBe(false);
    expect(parsePublishJob({ ...VALIDO, postId: "" }).ok).toBe(false);
  });

  it("rechaza lo que no es un objeto", () => {
    expect(parsePublishJob(null).ok).toBe(false);
    expect(parsePublishJob("publishing").ok).toBe(false);
    expect(parsePublishJob(undefined).ok).toBe(false);
  });
});
