/**
 * `/content/<formato>` · `F-070` (PRD:528-553) — las 22 rutas, y la única que
 * tiene pantalla.
 *
 * Dos cosas que ningún otro test cubre:
 *
 * 1. **Que las 22 rutas existan de verdad.** `generateStaticParams` es lo que
 *    las declara; si devolviera menos, `next build` prerenderizaría menos y las
 *    que falten se resolverían en runtime o en 404 según la configuración. Es
 *    un fallo que no se ve en desarrollo.
 * 2. **Que `custom` —y sólo `custom`— ofrezca subir un archivo**
 *    (`P2-STUDIO-009`, `F-083`). Los otros 21 necesitan el wizard de
 *    `P2-STUDIO-002`, que no está: un `<input type="file">` en `/content/lego`
 *    sería un control que no puede terminar en nada.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import ContentFormatPage, { generateMetadata, generateStaticParams } from "./page";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function renderFormat(format: string): Promise<void> {
  const element = await ContentFormatPage({ params: Promise.resolve({ format }) });
  render(element, { wrapper });
}

describe("las 22 rutas se declaran para el build", () => {
  it("`generateStaticParams` devuelve 22 segmentos, sin repetir", () => {
    const params = generateStaticParams();
    expect(params).toHaveLength(22);
    expect(new Set(params.map((param) => param.format)).size).toBe(22);
  });

  it("entre ellas están la primera de la tabla, `custom` y la última", () => {
    const segments = generateStaticParams().map((param) => param.format);
    expect(segments[0]).toBe("slideshow");
    expect(segments).toContain("custom");
    expect(segments.at(-1)).toBe("character-swap");
  });

  it("el título de la pestaña es el label del formato", async () => {
    await expect(
      generateMetadata({ params: Promise.resolve({ format: "lego" }) }),
    ).resolves.toEqual({ title: "Lego · FastGram" });
  });

  it("un segmento inventado no inventa un título", async () => {
    await expect(
      generateMetadata({ params: Promise.resolve({ format: "no-existe" }) }),
    ).resolves.toEqual({ title: "Content · FastGram" });
  });
});

describe("qué se dibuja en cada formato", () => {
  it("`custom` ofrece subir un video · F-083", async () => {
    await renderFormat("custom");

    expect(screen.getByLabelText("Video file")).toBeInTheDocument();
    // Y ya no es un placeholder: si alguien vuelve a poner uno encima, esto cae.
    expect(screen.queryByText("Custom is not built yet")).toBeNull();
    // El límite que ve el usuario antes de elegir nada.
    expect(screen.getByText("MP4 or MOV, up to 50 MB.")).toBeInTheDocument();
  });

  it("los otros 21 NO ofrecen subir nada: enseñan el placeholder", async () => {
    await renderFormat("lego");

    // La negativa primero: es lo que este caso mide.
    expect(screen.queryByLabelText("Video file")).toBeNull();
    expect(screen.getByText("Lego is not built yet")).toBeInTheDocument();
    expect(
      screen.getByText("Stop-motion Lego brick ad with narration and captions"),
    ).toBeInTheDocument();
  });

  it("un segmento que no es un formato es un 404, no una página vacía", async () => {
    // `notFound()` lanza; lo que importa es que no devuelva una pantalla.
    await expect(
      ContentFormatPage({ params: Promise.resolve({ format: "no-existe" }) }),
    ).rejects.toThrow();
  });
});
