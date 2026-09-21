import { cva, type VariantProps } from "class-variance-authority";

export const paginationVariants = cva("fg-pagination", {
  variants: {
    size: {
      sm: "fg-pagination--sm",
      md: "fg-pagination--md",
    },
    /**
     * `status` muestra `Page X of Y` entre las flechas — es lo que hace el
     * modal `Select Video` del PRD (§3.4, M-01). `numbers` muestra los números
     * con elipsis, para listados largos donde saltar de página tiene sentido.
     */
    display: {
      status: "fg-pagination--status",
      numbers: "fg-pagination--numbers",
    },
  },
  defaultVariants: { size: "md", display: "status" },
});

export type PaginationVariants = VariantProps<typeof paginationVariants>;
