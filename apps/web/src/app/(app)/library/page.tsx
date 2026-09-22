import type { Metadata } from "next";
import { LibraryTabs } from "@/components/library/LibraryTabs";
import { PageHeader } from "@/components/shell/PageHeader";
import { tw } from "@/lib/i18n/t";

export const metadata: Metadata = { title: "Library · FastGram" };

/**
 * `/library` · FR-100 (PRD:1601-1620), §3.1 (PRD:259).
 *
 * Server component fino: el `<h1>` y el shell. Todo lo que habla con la API
 * vive en `LibraryTabs`, que es cliente — `apps/web` no hace fetch desde el
 * servidor (ver `lib/api/client.ts`).
 */
export default function LibraryPage() {
  return (
    <div className="fgw-page">
      <PageHeader title={tw("library.title")} />
      <LibraryTabs />
    </div>
  );
}
