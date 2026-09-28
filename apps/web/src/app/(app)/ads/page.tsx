import type { Metadata } from "next";
import { Suspense } from "react";
import { AdsHome } from "@/components/ads/AdsHome";
import { PageHeader } from "@/components/shell/PageHeader";
import { tw } from "@/lib/i18n/t";

export const metadata: Metadata = { title: "Ads · FastGram" };

/**
 * `/ads` · sprint 9 (R), `D-21`: campañas pagas en Meta de la marca activa y
 * el dashboard de marketing. Todo lo que habla con la API es cliente.
 * `Suspense` porque `AdsHome` lee la query (`?connect=` del callback).
 */
export default function AdsPage() {
  return (
    <div className="fgw-page">
      <PageHeader title={tw("ads.title")} description={tw("ads.subtitle")} />
      <Suspense>
        <AdsHome />
      </Suspense>
    </div>
  );
}
