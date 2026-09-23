import type { Metadata } from "next";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";
import { firstParam, type SearchParams } from "@/lib/auth/search-params";

export const metadata: Metadata = {
  title: "Choose a new password · FastGram",
  // El token viaja en la URL: que no la mande como `Referer` a ningún enlace.
  referrer: "no-referrer",
};

/** `/reset-password?token=…` · PRD §15.3 (INFERRED). */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const token = firstParam((await searchParams)["token"]);
  return <ResetPasswordForm token={token === null || token === "" ? null : token} />;
}
