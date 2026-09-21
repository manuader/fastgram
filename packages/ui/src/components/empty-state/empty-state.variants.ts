import { cva, type VariantProps } from "class-variance-authority";

export const emptyStateVariants = cva("fg-state", {
  variants: {
    size: {
      sm: "fg-state--sm",
      md: "fg-state--md",
      lg: "fg-state--lg",
    },
    bordered: {
      true: "fg-state--bordered",
      false: "",
    },
  },
  defaultVariants: { size: "md", bordered: false },
});

export type EmptyStateVariants = VariantProps<typeof emptyStateVariants>;
