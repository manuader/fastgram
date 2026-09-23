import type { Metadata } from "next";
import { SignupForm } from "@/components/auth/SignupForm";
import { RETURN_TO_PARAM, safeReturnTo } from "@/lib/auth/route-policy";
import { firstParam, type SearchParams } from "@/lib/auth/search-params";

export const metadata: Metadata = { title: "Sign up · FastGram" };

/** `/signup` y `/signup/*` · F-001, PRD §15.1. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  return <SignupForm returnTo={safeReturnTo(firstParam(params[RETURN_TO_PARAM]))} />;
}
