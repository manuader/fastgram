import type { Metadata } from "next";
import { ModelsScreen } from "@/components/models/ModelsScreen";

export const metadata: Metadata = { title: "Models · FastGram" };

/**
 * `/models` · biblioteca de modelos del dueño (sprint 8, K). Server component
 * fino: todo lo que habla con la API vive en `ModelsScreen`, que es cliente.
 */
export default function Page() {
  return <ModelsScreen />;
}
