import type { Metadata } from "next";
import { BrandProfile } from "@/components/brand/BrandProfile";
import { PageHeader } from "@/components/shell/PageHeader";
import { tw } from "@/lib/i18n/t";

export const metadata: Metadata = { title: "Brand · FastGram" };

/**
 * `/brand` · FR-020 (PRD:996-1025), §3.1.
 *
 * Server component fino, igual que `/library` y `/blitz/settings`: el `<h1>` y
 * el shell. Todo lo que habla con la API vive en `BrandProfile`, que es
 * cliente — `apps/web` no hace fetch desde el servidor (ver `lib/api/client.ts`).
 */
export default function BrandPage() {
  return (
    <div className="fgw-page">
      <PageHeader
        title={tw("brand.profile.title")}
        description={tw("brand.profile.subtitle")}
      />
      <BrandProfile />
    </div>
  );
}
