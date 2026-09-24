import type { Metadata } from "next";
import { BrandsManager } from "@/components/brands/BrandsManager";
import { PageHeader } from "@/components/shell/PageHeader";
import { tw } from "@/lib/i18n/t";

export const metadata: Metadata = { title: "Brands · FastGram" };

/** `/settings/brands` · `PU-BRAND-001` (PRD §2.7 D-07: una marca = un workspace). */
export default function SettingsBrandsPage() {
  return (
    <div className="fgw-page">
      <PageHeader
        title={tw("brands.page.title")}
        description={tw("brands.page.description")}
      />
      <BrandsManager />
    </div>
  );
}
