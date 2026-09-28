import type { Metadata } from "next";
import { BlitzSettingsForm } from "@/components/blitz/BlitzSettingsForm";
import { WhatBlitzLearned } from "@/components/preferences/WhatBlitzLearned";
import { PageHeader } from "@/components/shell/PageHeader";
import { tw } from "@/lib/i18n/t";

export const metadata: Metadata = { title: "Blitz Settings · FastGram" };

/**
 * `/blitz/settings` · FR-055 (PRD:1255-1300), §3.1 (PRD:260).
 *
 * Server component fino, igual que `/library`: el `<h1>` y el shell. Todo lo
 * que habla con la API vive en `BlitzSettingsForm`, que es cliente — `apps/web`
 * no hace fetch desde el servidor (ver `lib/api/client.ts`).
 */
export default function BlitzSettingsPage() {
  return (
    <div className="fgw-page">
      <PageHeader title={tw("prefs.title")} />
      <BlitzSettingsForm />
      {/* Sprint 9 (Q): lo aprendido de las decisiones en Blitz (D-22). */}
      <WhatBlitzLearned />
    </div>
  );
}
