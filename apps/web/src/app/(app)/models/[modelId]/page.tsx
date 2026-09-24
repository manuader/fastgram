import type { Metadata } from "next";
import { ModelDetailScreen } from "@/components/models/ModelDetailScreen";

export const metadata: Metadata = { title: "Model · FastGram" };

/** `/models/:modelId` · un modelo de la biblioteca (sprint 8, K). */
export default async function ModelDetailPage({
  params,
}: {
  readonly params: Promise<{ modelId: string }>;
}) {
  const { modelId } = await params;
  return <ModelDetailScreen modelId={modelId} />;
}
