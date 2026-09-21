import { cva, type VariantProps } from "class-variance-authority";

export const switchVariants = cva("fg-switch", {
  variants: {
    switchSize: {
      sm: "fg-switch--sm",
      md: "fg-switch--md",
    },
  },
  defaultVariants: { switchSize: "md" },
});

export type SwitchVariants = VariantProps<typeof switchVariants>;
