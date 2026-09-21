import { cva, type VariantProps } from "class-variance-authority";

export const skeletonVariants = cva("fg-skeleton", {
  variants: {
    shape: {
      text: "fg-skeleton--text",
      rect: "fg-skeleton--rect",
      circle: "fg-skeleton--circle",
    },
  },
  defaultVariants: { shape: "rect" },
});

export type SkeletonVariants = VariantProps<typeof skeletonVariants>;
