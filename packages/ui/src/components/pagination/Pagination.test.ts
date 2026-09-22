import { describe, expect, it } from "vitest";
import { t } from "../../i18n/t";
import { getPaginationRange } from "../../lib/pagination";
import { paginationVariants } from "./pagination.variants";

describe("paginationVariants", () => {
  it("por defecto muestra `Page X of Y`, como el modal M-01 del PRD", () => {
    expect(paginationVariants()).toBe(
      "fg-pagination fg-pagination--md fg-pagination--status",
    );
  });

  it("permite el modo con números", () => {
    expect(paginationVariants({ display: "numbers" })).toContain(
      "fg-pagination--numbers",
    );
  });
});

describe("copy del paginador", () => {
  it("el status usa el copy literal del PRD", () => {
    expect(t("pagination.pageXofY", { current: 3, total: 72 })).toBe("Page 3 of 72");
  });
});

describe("rango de páginas del modo numbers", () => {
  it("el carrusel de trending del PRD (3 / 72) sale con elipsis a la derecha", () => {
    expect(getPaginationRange({ current: 3, total: 72 })).toEqual([
      1,
      2,
      3,
      4,
      5,
      "ellipsis",
      72,
    ]);
  });
});
