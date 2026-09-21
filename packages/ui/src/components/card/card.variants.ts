import { cva, type VariantProps } from "class-variance-authority";

export const cardVariants = cva("fg-card", {
  variants: {
    tone: {
      default: "fg-card--default",
      raised: "fg-card--raised",
      sunken: "fg-card--sunken",
      outline: "fg-card--outline",
    },
    padding: {
      none: "fg-card--pad-none",
      sm: "fg-card--pad-sm",
      md: "fg-card--pad-md",
      lg: "fg-card--pad-lg",
    },
    interactive: {
      true: "fg-card--interactive",
      false: "",
    },
  },
  defaultVariants: { tone: "default", padding: "md", interactive: false },
});

export type CardVariants = VariantProps<typeof cardVariants>;
