import { cva, type VariantProps } from "class-variance-authority";

export const tooltipVariants = cva("fg-tooltip__content", {
  variants: {
    side: {
      top: "fg-tooltip__content--top",
      right: "fg-tooltip__content--right",
      bottom: "fg-tooltip__content--bottom",
      left: "fg-tooltip__content--left",
    },
  },
  defaultVariants: { side: "top" },
});

export type TooltipVariants = VariantProps<typeof tooltipVariants>;
