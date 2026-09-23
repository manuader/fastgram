import type { Metadata } from "next";
import { OnboardingFlow } from "@/components/onboarding/OnboardingFlow";

export const metadata: Metadata = { title: "Onboarding · FastGram" };

/**
 * `/onboarding` · FR-010, FR-011 (EXTENSION). Server component fino: todo lo que
 * habla con la API es cliente (`apps/web` no hace fetch desde el servidor).
 * Pasos construidos: 1 (`P1-ONB-002`) y 4 (`P1-ONB-005`). El wizard es
 * `P1-ONB-001`.
 */
export default function OnboardingPage() {
  return <OnboardingFlow />;
}
