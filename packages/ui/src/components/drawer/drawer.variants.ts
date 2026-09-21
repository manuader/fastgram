import { cva, type VariantProps } from "class-variance-authority";

export const drawerVariants = cva("fg-drawer", {
  variants: {
    side: {
      left: "fg-drawer--left",
      right: "fg-drawer--right",
      top: "fg-drawer--top",
      bottom: "fg-drawer--bottom",
    },
    size: {
      sm: "fg-drawer--sm",
      md: "fg-drawer--md",
      lg: "fg-drawer--lg",
    },
  },
  defaultVariants: { side: "right", size: "md" },
});

export type DrawerVariants = VariantProps<typeof drawerVariants>;
