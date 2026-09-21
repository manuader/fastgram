import { cva, type VariantProps } from "class-variance-authority";

/**
 * El bloque de tonos de plataforma existe porque el PRD colorea por plataforma
 * en dos sitios: los chips del calendario (`F-141`) y el desglose de Analytics
 * (`F-171`). El color sale de los tokens `--fg-platform-*`.
 */
export const badgeVariants = cva("fg-badge", {
  variants: {
    tone: {
      neutral: "fg-badge--neutral",
      accent: "fg-badge--accent",
      success: "fg-badge--success",
      warning: "fg-badge--warning",
      danger: "fg-badge--danger",
      info: "fg-badge--info",
      outline: "fg-badge--outline",
      tiktok: "fg-badge--tiktok",
      instagram: "fg-badge--instagram",
      youtube: "fg-badge--youtube",
      linkedin: "fg-badge--linkedin",
      reddit: "fg-badge--reddit",
    },
    size: {
      sm: "fg-badge--sm",
      md: "fg-badge--md",
    },
  },
  defaultVariants: { tone: "neutral", size: "md" },
});

export type BadgeVariants = VariantProps<typeof badgeVariants>;

/** Los tonos que corresponden a una plataforma social. */
export const PLATFORM_TONES = [
  "tiktok",
  "instagram",
  "youtube",
  "linkedin",
  "reddit",
] as const;

export type PlatformTone = (typeof PLATFORM_TONES)[number];
