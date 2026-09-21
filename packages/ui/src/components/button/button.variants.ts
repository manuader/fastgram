import { cva, type VariantProps } from "class-variance-authority";

/**
 * Variantes del botón. Viven aparte del componente para que se puedan testear
 * sin montar React: son un mapa de props a clases, y eso es lógica pura.
 */
export const buttonVariants = cva("fg-btn", {
  variants: {
    variant: {
      primary: "fg-btn--primary",
      secondary: "fg-btn--secondary",
      ghost: "fg-btn--ghost",
      danger: "fg-btn--danger",
      link: "fg-btn--link",
    },
    size: {
      sm: "fg-btn--sm",
      md: "fg-btn--md",
      lg: "fg-btn--lg",
      icon: "fg-btn--icon",
    },
    fullWidth: {
      true: "fg-btn--full",
      false: "",
    },
  },
  defaultVariants: {
    variant: "primary",
    size: "md",
    fullWidth: false,
  },
});

export type ButtonVariants = VariantProps<typeof buttonVariants>;
