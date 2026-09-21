import { cva, type VariantProps } from "class-variance-authority";

export const errorStateVariants = cva("fg-state", {
  variants: {
    size: {
      sm: "fg-state--sm",
      md: "fg-state--md",
      lg: "fg-state--lg",
    },
    tone: {
      danger: "fg-state--danger",
      warning: "fg-state--warning",
      neutral: "",
    },
    bordered: {
      true: "fg-state--bordered",
      false: "",
    },
  },
  defaultVariants: { size: "md", tone: "danger", bordered: false },
});

export type ErrorStateVariants = VariantProps<typeof errorStateVariants>;
