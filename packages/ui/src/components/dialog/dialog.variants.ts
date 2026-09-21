import { cva, type VariantProps } from "class-variance-authority";

export const dialogVariants = cva("fg-dialog", {
  variants: {
    size: {
      sm: "fg-dialog--sm",
      md: "fg-dialog--md",
      lg: "fg-dialog--lg",
      xl: "fg-dialog--xl",
      full: "fg-dialog--full",
    },
  },
  defaultVariants: { size: "md" },
});

export type DialogVariants = VariantProps<typeof dialogVariants>;
