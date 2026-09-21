import { cva, type VariantProps } from "class-variance-authority";

export const spinnerVariants = cva("fg-spinner", {
  variants: {
    size: {
      xs: "fg-spinner--xs",
      sm: "fg-spinner--sm",
      md: "fg-spinner--md",
      lg: "fg-spinner--lg",
    },
    tone: {
      current: "fg-spinner--current",
      accent: "fg-spinner--accent",
      muted: "fg-spinner--muted",
    },
  },
  defaultVariants: { size: "md", tone: "current" },
});

export type SpinnerVariants = VariantProps<typeof spinnerVariants>;
