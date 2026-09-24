/**
 * Iconos de la shell.
 *
 * **Por qué SVG a mano y no `lucide-react`:** `packages/ui` sí lo usa, pero es
 * dependencia **suya**, no de `apps/web`, y bajo pnpm no resuelve desde aquí.
 * Esta tarea no puede tocar `package.json` (hay agentes en paralelo), así que
 * los 20 iconos que el sidebar necesita van inline. Si alguien añade
 * `lucide-react` a `apps/web`, este archivo se borra y se importan de allí: las
 * props (`size`, `className`, `aria-hidden`) son las mismas a propósito.
 *
 * Todos son decorativos: `aria-hidden` por defecto. Un icono que sea la única
 * etiqueta de un control necesita `aria-label` **en el control**, no aquí.
 */
import type { ReactNode, SVGProps } from "react";

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  size?: number;
}

interface InternalIconProps extends IconProps {
  children: ReactNode;
}

function Icon({ size = 20, children, ...rest }: InternalIconProps) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/* --------------------------------------------- bloque primario del sidebar */

export const HomeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 10.2 12 3l9 7.2" />
    <path d="M5.5 9.2V20a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V9.2" />
    <path d="M9.5 21v-6h5v6" />
  </Icon>
);

export const UsersIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
    <circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
    <path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </Icon>
);

export const RocketIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09Z" />
    <path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2Z" />
    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0" />
    <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5" />
  </Icon>
);

export const WandIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m11 4-1.3 3.9a2 2 0 0 1-1.3 1.3L4.5 10.5l3.9 1.3a2 2 0 0 1 1.3 1.3L11 17l1.3-3.9a2 2 0 0 1 1.3-1.3l3.9-1.3-3.9-1.3a2 2 0 0 1-1.3-1.3Z" />
    <path d="M18 3v4" />
    <path d="M20 5h-4" />
    <path d="M18 17v4" />
    <path d="M20 19h-4" />
  </Icon>
);

export const UserIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" />
    <circle cx="12" cy="7" r="4" />
  </Icon>
);

export const ClapperboardIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20.2 6 3 11l-.9-2.4a2 2 0 0 1 1.3-2.5l13.5-4a2 2 0 0 1 2.5 1.3Z" />
    <path d="m6.2 5.3 3.1 3.9" />
    <path d="m12.4 3.4 3.1 4" />
    <path d="M3 11h18v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
  </Icon>
);

export const LibraryIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 4v16" />
    <path d="M8 5v15" />
    <path d="M12 4v16" />
    <path d="m16.5 5.5 4 13.5" />
  </Icon>
);

export const CalendarIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="4.5" width="18" height="16.5" rx="2" />
    <path d="M8 2.5v4" />
    <path d="M16 2.5v4" />
    <path d="M3 10h18" />
  </Icon>
);

export const BarChartIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 3v16a2 2 0 0 0 2 2h16" />
    <path d="M18 17V9" />
    <path d="M13 17V5" />
    <path d="M8 17v-4" />
  </Icon>
);

export const UsersRoundIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="10" cy="8" r="4.5" />
    <path d="M17.5 21a7.5 7.5 0 0 0-15 0" />
    <path d="M21.5 20c0-2.9-1.6-5.6-3.6-7" />
    <path d="M16 3.7a4.5 4.5 0 0 1 1 8.2" />
  </Icon>
);

/* -------------------------------------------- bloque secundario del sidebar */

export const ShieldIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 2.5 4.5 5.5v6c0 5 3.2 8.6 7.5 10 4.3-1.4 7.5-5 7.5-10v-6Z" />
  </Icon>
);

export const GiftIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="8" width="18" height="4" rx="1" />
    <path d="M12 8v13" />
    <path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7" />
    <path d="M7.5 8a2.5 2.5 0 0 1 0-5C10 3 12 6 12 8" />
    <path d="M16.5 8a2.5 2.5 0 0 0 0-5C14 3 12 6 12 8" />
  </Icon>
);

export const BriefcaseIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2" y="6.5" width="20" height="14" rx="2" />
    <path d="M16 20.5V4.5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16" />
  </Icon>
);

export const MapIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M9 3.5 3.5 6v14.5L9 18l6 2.5 5.5-2.5V3.5L15 6Z" />
    <path d="M9 3.5V18" />
    <path d="M15 6v14.5" />
  </Icon>
);

export const MessageSquareIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M21 14.5a2.5 2.5 0 0 1-2.5 2.5H8l-5 4V5.5A2.5 2.5 0 0 1 5.5 3h13A2.5 2.5 0 0 1 21 5.5Z" />
  </Icon>
);

/** Logotipo de Discord (PRD:334). Relleno, no trazo: es una marca, no un icono de línea. */
export const DiscordIcon = ({ size = 20, ...props }: IconProps) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    focusable="false"
    {...props}
  >
    <path d="M19.3 5.3A16.7 16.7 0 0 0 15.2 4l-.2.4a12 12 0 0 0-5.9 0L8.8 4a16.7 16.7 0 0 0-4.1 1.3C2.1 9.2 1.4 13 1.7 16.7a16.8 16.8 0 0 0 5.1 2.6l1-1.7a11 11 0 0 1-1.6-.8l.4-.3a11.9 11.9 0 0 0 10.7 0l.4.3a11 11 0 0 1-1.6.8l1 1.7a16.8 16.8 0 0 0 5.1-2.6c.4-4.3-.6-8.1-2.9-11.4ZM8.4 14.5c-1 0-1.8-.9-1.8-2s.8-2.1 1.8-2.1 1.9.9 1.8 2.1c0 1.1-.8 2-1.8 2Zm7.2 0c-1 0-1.8-.9-1.8-2s.8-2.1 1.8-2.1 1.9.9 1.8 2.1c0 1.1-.8 2-1.8 2Z" />
  </svg>
);

export const SettingsIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 14a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V20a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 18.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 8a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V8a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
  </Icon>
);

/* ------------------------------------------------------------- utilidades */

export const PanelLeftIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M9.5 3v18" />
  </Icon>
);

export const MenuIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M4 6h16" />
    <path d="M4 12h16" />
    <path d="M4 18h16" />
  </Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M18 6 6 18" />
    <path d="m6 6 12 12" />
  </Icon>
);

export const SunIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2v2" />
    <path d="M12 20v2" />
    <path d="m4.9 4.9 1.4 1.4" />
    <path d="m17.7 17.7 1.4 1.4" />
    <path d="M2 12h2" />
    <path d="M20 12h2" />
    <path d="m6.3 17.7-1.4 1.4" />
    <path d="m19.1 4.9-1.4 1.4" />
  </Icon>
);

export const MoonIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3a6.5 6.5 0 0 0 9 9 9 9 0 1 1-9-9Z" />
  </Icon>
);

export const MonitorIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="2" y="3.5" width="20" height="13" rx="2" />
    <path d="M8 20.5h8" />
    <path d="M12 16.5v4" />
  </Icon>
);

export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m6 9 6 6 6-6" />
  </Icon>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m9 18 6-6-6-6" />
  </Icon>
);

export const ExternalLinkIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M15 3h6v6" />
    <path d="M10 14 21 3" />
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  </Icon>
);

export const EyeIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Icon>
);

export const HeartIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z" />
  </Icon>
);

export const MessageCircleIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
  </Icon>
);

export const InfoIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5" />
    <path d="M12 7.6h.01" />
  </Icon>
);

export const LifeBuoyIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="12" cy="12" r="9" />
    <circle cx="12" cy="12" r="3.6" />
    <path d="m5.6 5.6 3.9 3.9" />
    <path d="m14.5 14.5 3.9 3.9" />
    <path d="m18.4 5.6-3.9 3.9" />
    <path d="m9.5 14.5-3.9 3.9" />
  </Icon>
);

/* ------------------------------------------------- Calendar · F-140, F-143 */

export const ChevronLeftIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m15 18-6-6 6-6" />
  </Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M20 6 9 17l-5-5" />
  </Icon>
);

export const InboxIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M22 12h-6l-2 3h-4l-2-3H2" />
    <path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
  </Icon>
);

/* ------------------------------------ Shell 2026 · PU-UI-001, PU-BRAND-001 */

export const SearchIcon = (props: IconProps) => (
  <Icon {...props}>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </Icon>
);

export const PlusIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </Icon>
);

export const ChevronsUpDownIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m7 15 5 5 5-5" />
    <path d="m7 9 5-5 5 5" />
  </Icon>
);

export const PencilIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    <path d="m15 5 4 4" />
  </Icon>
);

export const TrashIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M3 6h18" />
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
  </Icon>
);

export const ZapIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8Z" />
  </Icon>
);

export const LayersIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="m12 2 10 5-10 5L2 7Z" />
    <path d="m2 17 10 5 10-5" />
    <path d="m2 12 10 5 10-5" />
  </Icon>
);

export const CpuIcon = (props: IconProps) => (
  <Icon {...props}>
    <rect x="5" y="5" width="14" height="14" rx="2" />
    <rect x="9" y="9" width="6" height="6" />
    <path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  </Icon>
);

export const SunMoonIcon = (props: IconProps) => (
  <Icon {...props}>
    <path d="M12 3a9 9 0 1 0 9 9 7 7 0 0 1-9-9Z" />
    <path d="M17 3v2M21 7h-2" />
  </Icon>
);
