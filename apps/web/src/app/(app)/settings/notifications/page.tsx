import type { Metadata } from "next";
import { PageHeader } from "@/components/shell/PageHeader";
import { NotificationSettings } from "@/components/notifications/NotificationSettings";
import { NOTIFICATIONS_COPY } from "@/components/notifications/copy";

export const metadata: Metadata = { title: "Notifications · FastGram" };

/**
 * `/settings/notifications` · `P5-NOTIF-002/003` (sprint 7), PRD §13.4.
 *
 * Server component fino, como `/settings/strategy`: el `<h1>` y el resto en
 * el cliente. Las preferencias son de la instalación, no de la marca activa.
 */
export default function SettingsNotificationsPage() {
  return (
    <div className="fgw-page">
      <PageHeader
        title={NOTIFICATIONS_COPY.pageTitle}
        description={NOTIFICATIONS_COPY.pageDescription}
      />
      <NotificationSettings />
    </div>
  );
}
