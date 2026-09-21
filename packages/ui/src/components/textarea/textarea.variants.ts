import { cva, type VariantProps } from "class-variance-authority";

export const textareaVariants = cva("fg-textarea", {
  variants: {
    invalid: {
      true: "fg-textarea--invalid",
      false: "",
    },
    resize: {
      none: "fg-textarea--resize-none",
      vertical: "fg-textarea--resize-y",
      both: "fg-textarea--resize-both",
    },
  },
  defaultVariants: { invalid: false, resize: "vertical" },
});

export type TextareaVariants = VariantProps<typeof textareaVariants>;
