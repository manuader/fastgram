import type { Metadata } from "next";
import { LoginForm } from "@/components/auth/LoginForm";
import {
  REASON_PARAM,
  RETURN_TO_PARAM,
  safeReturnTo,
  SESSION_UNVERIFIED_REASON,
} from "@/lib/auth/route-policy";
import { firstParam, type SearchParams } from "@/lib/auth/search-params";

export const metadata: Metadata = { title: "Login · FastGram" };

/** `/login` y `/login/*` · F-002, PRD §15.2. */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  return (
    <LoginForm
      returnTo={safeReturnTo(firstParam(params[RETURN_TO_PARAM]))}
      sessionUnverified={firstParam(params[REASON_PARAM]) === SESSION_UNVERIFIED_REASON}
    />
  );
}
