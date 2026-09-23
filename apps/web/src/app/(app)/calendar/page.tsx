import type { Metadata } from "next";
import { CalendarView } from "@/components/calendar/CalendarView";
import { PageHeader } from "@/components/shell/PageHeader";
import { tw } from "@/lib/i18n/t";

export const metadata: Metadata = { title: "Calendar · FastGram" };

/**
 * `/calendar` · FR-110 (PRD:1653-1668), §3.1 (PRD:260).
 *
 * Server component fino, como `/library`: el `<h1>` y el shell. La vista es
 * cliente — habla con la API y resuelve la zona del navegador después de montar.
 */
export default function CalendarPage() {
  return (
    <div className="fgw-page">
      <PageHeader title={tw("calendar.title")} />
      <CalendarView />
    </div>
  );
}
