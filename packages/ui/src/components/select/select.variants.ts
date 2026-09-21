import { cva, type VariantProps } from "class-variance-authority";

export const selectVariants = cva("fg-select__control", {
  variants: {
    selectSize: {
      sm: "fg-select__control--sm",
      md: "fg-select__control--md",
      lg: "fg-select__control--lg",
    },
    invalid: {
      true: "fg-select__control--invalid",
      false: "",
    },
  },
  defaultVariants: { selectSize: "md", invalid: false },
});

export type SelectVariants = VariantProps<typeof selectVariants>;
