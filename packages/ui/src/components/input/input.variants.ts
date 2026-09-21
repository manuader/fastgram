import { cva, type VariantProps } from "class-variance-authority";

export const inputVariants = cva("fg-input", {
  variants: {
    inputSize: {
      sm: "fg-input--sm",
      md: "fg-input--md",
      lg: "fg-input--lg",
    },
    invalid: {
      true: "fg-input--invalid",
      false: "",
    },
    hasLeadingIcon: {
      true: "fg-input--with-icon",
      false: "",
    },
  },
  defaultVariants: { inputSize: "md", invalid: false, hasLeadingIcon: false },
});

export type InputVariants = VariantProps<typeof inputVariants>;
