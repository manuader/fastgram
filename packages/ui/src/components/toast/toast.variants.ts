import { cva, type VariantProps } from "class-variance-authority";

export const toastVariants = cva("fg-toast", {
  variants: {
    tone: {
      neutral: "fg-toast--neutral",
      success: "fg-toast--success",
      warning: "fg-toast--warning",
      danger: "fg-toast--danger",
      info: "fg-toast--info",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export type ToastVariants = VariantProps<typeof toastVariants>;
