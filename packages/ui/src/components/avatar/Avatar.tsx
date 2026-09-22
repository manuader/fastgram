"use client";

import { useState, type ComponentPropsWithRef, type ReactNode } from "react";
import { cn } from "../../cn";
import { getInitials } from "../../lib/initials";
import { avatarVariants, type AvatarVariants } from "./avatar.variants";

export interface AvatarProps
  extends Omit<ComponentPropsWithRef<"span">, "children">, AvatarVariants {
  /** URL de la imagen. Si falla la carga, se cae a las iniciales. */
  src?: string;
  /** Nombre de la persona o del influencer. Origen de las iniciales. */
  name?: string;
  /**
   * Texto alternativo de la imagen. Por defecto vacío: el avatar suele ir junto
   * al nombre escrito, y repetirlo hace que el lector de pantalla lo lea dos
   * veces. Pasalo sólo cuando el avatar va solo.
   */
  alt?: string;
  /** Contenido a medida (un icono, por ejemplo) en lugar de las iniciales. */
  fallback?: ReactNode;
}

/**
 * Avatar de usuario o de influencer (PRD `F-090`: la grid de personajes).
 *
 * Orden de caída: imagen → `fallback` → iniciales del nombre → nada.
 */
export function Avatar({
  size,
  shape,
  src,
  name,
  alt = "",
  fallback,
  className,
  ...props
}: AvatarProps) {
  const [failed, setFailed] = useState(false);
  const showImage = src !== undefined && src !== "" && !failed;
  const initials = name === undefined ? "" : getInitials(name);

  return (
    <span {...props} className={cn(avatarVariants({ size, shape }), className)}>
      {showImage ? (
        <img
          className="fg-avatar__image"
          src={src}
          alt={alt}
          onError={() => {
            setFailed(true);
          }}
        />
      ) : (
        <span
          className="fg-avatar__fallback"
          aria-hidden={alt === "" ? "true" : undefined}
        >
          {fallback ?? initials}
        </span>
      )}
    </span>
  );
}
