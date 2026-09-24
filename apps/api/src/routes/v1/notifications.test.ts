/**
 * Las categorías viven en `core` y están copiadas en el contrato (que no
 * importa `core`) y en el CHECK de `0028_notifications.sql`. Si una se agrega
 * de un lado y no del otro, el worker escribe algo que la base rechaza o que
 * la API no puede devolver: este test lo dice antes.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { NOTIFICATION_CATEGORY_VALUES } from "@fastgram/contracts";
import { NOTIFICATION_CATEGORIES } from "@fastgram/core";

import { webBaseUrlFrom } from "./notifications.js";

describe("categorías de notificación", () => {
  it("core y el contrato dicen lo mismo", () => {
    expect([...NOTIFICATION_CATEGORY_VALUES]).toEqual([...NOTIFICATION_CATEGORIES]);
  });

  it("el CHECK de la migración las acepta todas", () => {
    const sqlPath = fileURLToPath(
      new URL(
        "../../../../../packages/db/drizzle/0028_notifications.sql",
        import.meta.url,
      ),
    );
    const migration = readFileSync(sqlPath, "utf8");
    const check =
      /notifications_category_check" CHECK \("category" IN \(([^)]*)\)\)/u.exec(
        migration,
      );
    const inCheck = [...(check?.[1] ?? "").matchAll(/'([a-z_]+)'/gu)].map((m) => m[1]);
    expect(inCheck.sort()).toEqual([...NOTIFICATION_CATEGORIES].sort());
  });
});

describe("webBaseUrlFrom", () => {
  it("usa FASTGRAM_WEB_URL si es http(s), si no localhost:3000", () => {
    expect(webBaseUrlFrom({ FASTGRAM_WEB_URL: "https://fg.example.test/" })).toBe(
      "https://fg.example.test",
    );
    expect(webBaseUrlFrom({ FASTGRAM_WEB_URL: "javascript:alert(1)" })).toBe(
      "http://localhost:3000",
    );
    expect(webBaseUrlFrom({})).toBe("http://localhost:3000");
  });
});
