import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { RoutePlaceholder } from "@/components/placeholder/RoutePlaceholder";
import { isOAuthCallbackPlatform, OAUTH_CALLBACK_PLATFORMS } from "@/lib/nav/routes";

interface PageProps {
  params: Promise<{ platform: string }>;
}

export const metadata: Metadata = { title: "Connecting · FastGram" };

/**
 * `/auth/<plataforma>/callback` · PRD:287-291 — cinco rutas, una por plataforma.
 *
 * Lista blanca y `notFound()` para lo demás: un callback OAuth que acepta
 * cualquier segmento es una superficie de ataque, no una comodidad.
 *
 * **Lo que falta aquí es la mitad importante.** Un callback real lee `code` y
 * `state`, verifica el `state` contra el que guardó la app y canjea el código
 * **en el servidor**. Nada de eso puede vivir en `apps/web` (el intercambio usa
 * el secreto del cliente): es `P3-OAUTH-*` en `apps/api`. Esta página sólo
 * existirá para enseñar el resultado.
 */
export default async function OAuthCallbackPage({ params }: PageProps) {
  const { platform } = await params;
  if (!isOAuthCallbackPlatform(platform)) notFound();

  return (
    <RoutePlaceholder
      screen={`OAuth callback · ${platform}`}
      spec="PRD §3.1 · INT-001…INT-005 · §19.5"
      task="P3-OAUTH-001"
    >
      <p>Platforms with a callback route: {OAUTH_CALLBACK_PLATFORMS.join(", ")}.</p>
    </RoutePlaceholder>
  );
}
