import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/shell/PageHeader";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";

export const metadata: Metadata = { title: "Settings · FastGram" };

/**
 * `/settings` · el hub de Settings (sprint 7).
 *
 * Era un placeholder con las ocho secciones del sitemap del PRD (PRD:292),
 * la mitad de las cuales (billing, api, warmed accounts…) el modo personal no
 * tiene (D-06, D-15). Ahora es una tarjeta por cada sección que **existe**,
 * con lo que se hace ahí. `account`, `preferences` (tema e idioma están en el
 * shell), `billing`, `api` y `warmed-accounts` no tienen pantalla en el modo
 * personal y no se listan.
 */
const SECTIONS: ReadonlyArray<{
  readonly href: string;
  readonly title: string;
  readonly description: string;
}> = [
  {
    href: ROUTES.settingsBrands,
    title: tw("settings.nav.brands"),
    description:
      "Create, rename and delete brands. Each brand has its own accounts, strategy and queue.",
  },
  {
    href: ROUTES.settingsStrategy,
    title: tw("settings.nav.strategy"),
    description:
      "Networks, posts per day, posting windows, format mix and manual or autopilot.",
  },
  {
    href: ROUTES.settingsModels,
    title: tw("settings.nav.models"),
    description:
      "Which AI model does each task: text, judgment, vision, images and video.",
  },
  {
    href: ROUTES.settingsIntegrations,
    title: tw("settings.nav.integrations"),
    description: "Your developer apps for Meta, TikTok, X, YouTube and LinkedIn.",
  },
  {
    href: ROUTES.settingsConnections,
    title: tw("settings.nav.connections"),
    description: "The social accounts of the active brand: connect, check and reconnect.",
  },
  {
    href: ROUTES.settingsNotifications,
    title: "Notifications",
    description:
      "What the autopilot tells you, in the app and on your phone (ntfy or Telegram).",
  },
];

export default function SettingsPage() {
  return (
    <div className="fgw-page">
      <PageHeader title={tw("nav.settings")} />
      <ul className="m-0 grid list-none grid-cols-1 gap-3 p-0 sm:grid-cols-2 lg:grid-cols-3">
        {SECTIONS.map((section) => (
          <li key={section.href}>
            <Link
              href={section.href}
              className="fg-focusable flex h-full flex-col gap-1 rounded-md border border-border bg-surface p-4 hover:border-border-strong"
            >
              <span className="text-base font-semibold text-text">{section.title}</span>
              <span className="text-sm text-text-muted">{section.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
