import type { Metadata } from "next";
import { LogoutScreen } from "@/components/auth/LogoutScreen";

export const metadata: Metadata = { title: "Logout · FastGram" };

/** `/logout` · F-003. */
export default function Page() {
  return <LogoutScreen />;
}
