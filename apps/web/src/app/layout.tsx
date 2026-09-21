import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
// El orden de los dos imports **importa**: primero el design system, después las
// utilidades de Tailwind y el CSS de la shell. Así, ante un empate de
// especificidad, gana lo de la app — que es lo que uno espera al escribir una
// utilidad para ajustar algo. Al revés, cada ajuste necesitaría `!important`.
import "@fastgram/ui/styles.css";
import "./globals.css";
import { Providers } from "@/components/providers/Providers";
import { ThemeScript } from "@/components/theme/ThemeScript";
import { tw } from "@/lib/i18n/t";

export const metadata: Metadata = {
  title: { default: "FastGram", template: "%s" },
  description: "Content that ships while you sleep.",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  /**
   * `light dark` le dice al navegador que la app tiene las dos paletas, y con
   * eso pinta en el color correcto los scrollbars y los controles nativos
   * (`<select>`, checkboxes). Sin esto, en tema oscuro aparecen barras claras.
   */
  colorScheme: "light dark",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // `suppressHydrationWarning`: el script del `<head>` le pone `data-theme`
    // al `<html>` **antes** de que React hidrate, así que el atributo del
    // cliente no coincide con el del HTML del servidor. Es intencionado y es
    // exactamente el precio de no tener flash (NFR-021). Sólo silencia este
    // elemento, no el árbol.
    <html lang="en" suppressHydrationWarning>
      <head>
        <ThemeScript />
      </head>
      <body>
        <a href="#main" className="fgw-skip-link fg-focusable">
          {tw("a11y.skipToContent")}
        </a>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
