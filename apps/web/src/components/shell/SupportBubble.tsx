"use client";

import { useToast } from "@fastgram/ui";
import { LifeBuoyIcon } from "@/icons";
import { tw } from "@/lib/i18n/t";

/**
 * Burbuja de soporte · PRD §3.2 (PRD:340): "widget flotante de soporte (burbuja
 * naranja) fijo en la esquina inferior derecha en **todas** las páginas",
 * CONFIRMED.
 *
 * El PRD confirma que existe y dónde está, pero **no dice qué abre** ni con qué
 * proveedor. Así que aquí está la burbuja, y al pulsarla dice exactamente eso
 * en lugar de abrir un chat inventado. Un botón que no hace nada enseña a
 * desconfiar de los demás botones.
 */
export function SupportBubble() {
  const { toast } = useToast();
  const label = tw("support.label");

  return (
    <button
      type="button"
      className="fgw-support fg-focusable"
      aria-label={label}
      onClick={() => {
        toast({
          title: tw("placeholder.noEndpoint.title"),
          description: tw("placeholder.noEndpoint.description"),
          tone: "info",
        });
      }}
    >
      <LifeBuoyIcon size={22} />
    </button>
  );
}
