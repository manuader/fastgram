import type { Metadata } from "next";
import { ForgotPasswordForm } from "@/components/auth/ForgotPasswordForm";

export const metadata: Metadata = { title: "Reset password · FastGram" };

/** `/forgot-password` · PRD §15.3 (INFERRED). Fuera del sitemap §3.1: ver `ROUTES`. */
export default function Page() {
  return <ForgotPasswordForm />;
}
