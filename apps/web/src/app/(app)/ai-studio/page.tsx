import type { Metadata } from "next";
import { AiStudioScreen } from "@/components/ai-studio/AiStudioScreen";

export const metadata: Metadata = { title: "AI Studio · FastGram" };

/**
 * `/ai-studio` · `PU-LATER-005` (FR-090 adaptado, `docs/PLAN-USO-PERSONAL.md`
 * §4). Server component fino: todo lo que habla con la API vive en
 * `AiStudioScreen`, que es cliente.
 */
export default function Page() {
  return <AiStudioScreen />;
}
