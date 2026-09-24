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
 *    (`P2-STUDIO-009`, `F-083`). Los cuatro base montan el Studio
 *    (`Create New` / `Remix`, sprint 7) y los generativos el estudio del
 *    agente G.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
  }),
  usePathname: () => "/content",
}));

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

  it("un formato base monta el Studio: Create New y Remix, sin subir archivos", async () => {
    await renderFormat("wall-of-text");

    // La negativa primero: es lo que este caso mide.
    expect(screen.queryByLabelText("Video file")).toBeNull();
    expect(screen.getByRole("tab", { name: "Create New" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Remix" })).toBeInTheDocument();
    // `Save` arranca deshabilitado (F-073).
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("un formato generativo no ofrece subir nada ni el Studio base", async () => {
    await renderFormat("lego");

    expect(screen.queryByLabelText("Video file")).toBeNull();
    expect(screen.queryByRole("tab", { name: "Create New" })).toBeNull();
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
