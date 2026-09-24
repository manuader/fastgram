/**
 * El journal de Drizzle tiene que estar ordenado por `when` en el mismo orden que por `idx`.
 *
 * El migrador de Postgres no compara nombres: toma el `created_at` de la última
 * migración aplicada y corre sólo las que tienen un `when` MAYOR. Si una
 * migración con número más chico tiene un `when` más grande (pasó el 2026-09-24:
 * dos agentes en paralelo crearon la 0013 y la 0014, y la 0013 quedó con el
 * `when` más nuevo), una base que aplique la 0013 antes que la 0014 se saltea la
 * 0014 **para siempre y sin error**. Este test lo corta al escribirlo, no al
 * desplegarlo.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

interface JournalEntry {
  readonly idx: number;
  readonly tag: string;
  readonly when: number;
}

const journal = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("../drizzle/meta/_journal.json", import.meta.url)),
    "utf8",
  ),
) as { entries: JournalEntry[] };

describe("drizzle/meta/_journal.json", () => {
  it("los `when` crecen estrictamente en el orden de `idx`", () => {
    const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);
    for (let i = 1; i < entries.length; i++) {
      const prev = entries[i - 1]!;
      const cur = entries[i]!;
      expect(
        cur.when,
        `${cur.tag} (when ${String(cur.when)}) no es posterior a ${prev.tag} (when ${String(prev.when)})`,
      ).toBeGreaterThan(prev.when);
    }
  });

  it("idx y el prefijo numérico del tag coinciden", () => {
    for (const e of journal.entries) {
      expect(e.tag.startsWith(String(e.idx).padStart(4, "0")), e.tag).toBe(true);
    }
  });
});
