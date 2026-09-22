/**
 * El hub `/content` · `F-070` (PRD:512, 528-553) — `P2-STUDIO-001`.
 *
 * ## Qué faltaba
 *
 * La pantalla ya estaba y el catálogo también; lo que no había era nada que
 * fijara **22**. Con el catálogo y la página tocables sin red, perder una
 * tarjeta —o ganar una— era un cambio silencioso: el hub es una grid, y una
 * grid con 21 tarjetas se ve exactamente igual de bien que con 22.
 *
 * El reparto con `lib/content/formats.test.ts` es deliberado: allí se comprueba
 * que **los datos** son los del PRD (una copia a mano de la tabla); acá, que
 * **la pantalla dibuja lo que hay en los datos**, entero y una vez cada cosa.
 * Juntarlos haría que la mitad de las aserciones se comparasen consigo mismas.
 *
 * `F-070` pide además "poster y video de ejemplo". No están —son assets que el
 * repo no tiene— y la página lo documenta. Lo que sí se fija acá es que esa
 * ausencia no se rellene con un `<video>` o un `<img>` sin fuente, que es la
 * forma habitual de "dejarlo preparado" y produce un icono roto en 22 sitios.
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CONTENT_FORMATS } from "@/lib/content/formats";
import ContentHubPage from "./page";

function renderHub(): HTMLElement {
  const { container } = render(<ContentHubPage />);
  return container;
}

/** Cada tarjeta es un enlace: la clase es propia de la tarjeta, no del grid. */
function cards(container: HTMLElement): HTMLAnchorElement[] {
  return [...container.querySelectorAll<HTMLAnchorElement>("a.fgw-format-card")];
}

describe("el hub dibuja los 22 formatos · F-070", () => {
  it("hay 22 tarjetas, ni una más", () => {
    const container = renderHub();
    // El número del PRD, escrito a mano. `CONTENT_FORMATS.length` acá sería el
    // test comparándose consigo mismo: el catálogo se fija en `formats.test.ts`.
    expect(cards(container)).toHaveLength(22);
    expect(screen.getAllByRole("link")).toHaveLength(22);
  });

  it("cada tarjeta lleva su label y su description, dentro de ella", () => {
    const container = renderHub();
    const byHref = new Map(
      cards(container).map((card) => [card.getAttribute("href"), card]),
    );

    for (const format of CONTENT_FORMATS) {
      const card = byHref.get(`/content/${format.id}`);
      expect(card, `falta la tarjeta de ${format.id}`).toBeDefined();
      // `within`, no `screen`: un `getByText` global pasaría aunque el label de
      // un formato apareciera en la tarjeta de otro.
      expect(within(card as HTMLElement).getByText(format.label)).toBeInTheDocument();
      expect(
        within(card as HTMLElement).getByText(format.description),
      ).toBeInTheDocument();
    }
  });

  it("los 22 destinos son distintos", () => {
    const container = renderHub();
    const hrefs = cards(container).map((card) => card.getAttribute("href"));
    expect(new Set(hrefs).size).toBe(22);
  });

  it("tres tarjetas concretas, con el texto literal del PRD", () => {
    // La primera de la tabla, la única con pantalla detrás (`custom`,
    // `P2-STUDIO-009`) y la última: si el orden del PRD se pierde, el `toEqual`
    // del test de datos lo dice, y esto dice cuál era.
    const container = renderHub();
    const byHref = new Map(
      cards(container).map((card) => [card.getAttribute("href"), card]),
    );

    const slideshow = byHref.get("/content/slideshow") as HTMLElement;
    expect(within(slideshow).getByText("Slideshow")).toBeInTheDocument();
    expect(
      within(slideshow).getByText("Multi-image carousel with captions"),
    ).toBeInTheDocument();

    const custom = byHref.get("/content/custom") as HTMLElement;
    expect(within(custom).getByText("Custom")).toBeInTheDocument();
    expect(
      within(custom).getByText("Upload your own video or image"),
    ).toBeInTheDocument();

    const swap = byHref.get("/content/character-swap") as HTMLElement;
    expect(within(swap).getByText("Character Swap")).toBeInTheDocument();
    expect(
      within(swap).getByText("Swap the character in a video using AI"),
    ).toBeInTheDocument();
  });
});

describe("la tarjeta es navegable, y no promete media que no hay", () => {
  it("es un `<a>` con href real: teclado y `abrir en pestaña nueva`", () => {
    const container = renderHub();
    for (const card of cards(container)) {
      expect(card.tagName).toBe("A");
      expect(card.getAttribute("href")).toMatch(/^\/content\/[a-z0-9-]+$/);
    }
  });

  it("hoy no hay poster ni video de ejemplo, y ninguno se finge", () => {
    // `F-070` los lista; el repo no tiene esos assets y nadie decidió de dónde
    // salen. La página lo documenta y no dibuja nada: un `<video src="">` pide
    // el documento actual y pinta un reproductor roto, 22 veces.
    const container = renderHub();
    const media = [...container.querySelectorAll("img, video, source")];

    // La alarma, no la solución: el día que lleguen los assets esto se pone
    // rojo y hay que venir a actualizar la nota de `page.tsx`, que hoy dice que
    // no están. Sin esta línea la aserción de abajo no mide nada —no hay
    // elementos que recorrer— y quedaría un test verde por vacío.
    expect(media).toHaveLength(0);
    for (const element of media) {
      expect(element.getAttribute("src") ?? "").not.toBe("");
    }
  });

  it("hay un único `h1`, y es el nombre de la pantalla", () => {
    renderHub();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("Content");
  });
});
