import { cva, type VariantProps } from "class-variance-authority";

export const avatarVariants = cva("fg-avatar", {
  variants: {
    size: {
      xs: "fg-avatar--xs",
      sm: "fg-avatar--sm",
      md: "fg-avatar--md",
      lg: "fg-avatar--lg",
      xl: "fg-avatar--xl",
    },
    shape: {
      circle: "fg-avatar--circle",
      square: "fg-avatar--square",
    },
  },
  defaultVariants: { size: "md", shape: "circle" },
});

export type AvatarVariants = VariantProps<typeof avatarVariants>;
