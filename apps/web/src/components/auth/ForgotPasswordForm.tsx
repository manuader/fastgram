"use client";

import { Button } from "@fastgram/ui";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import {
  presentAuthError,
  requestPasswordReset,
  type AuthErrorPresentation,
} from "@/lib/auth/auth-client";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { AuthAlert, AuthCard, AuthField } from "./AuthParts";

/**
 * `/forgot-password` · PRD §15.3 (INFERRED: "delegado al proveedor de
 * identidad"). Lo mínimo honesto: pedir el enlace. La confirmación es **la
 * misma exista o no la cuenta** — la API contesta `202` en los dos casos y la
 * pantalla no agrega nada que lo delate.
 */
export function ForgotPasswordForm() {
  const id = useId();
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<AuthErrorPresentation | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (email.trim() === "") {
      setProblem({ key: "auth.error.missingFields" });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch (error) {
      setProblem(presentAuthError(error, "forgot"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthCard titleId={`${id}-title`} title={tw("auth.forgot.title")}>
      {sent ? (
        <p role="status" className="fgw-auth__body">
          {tw("auth.forgot.sent")}
        </p>
      ) : (
        <>
          <p className="fgw-auth__body">{tw("auth.forgot.body")}</p>
          <form
            className="fgw-auth__form"
            onSubmit={(event) => void submit(event)}
            noValidate
            aria-busy={busy || undefined}
          >
            <AuthField
              id={`${id}-email`}
              label={tw("auth.field.email")}
              type="email"
              name="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
            {problem !== null && <AuthAlert problem={problem} />}
            <Button type="submit" loading={busy} disabled={busy}>
              {tw(busy ? "auth.forgot.submitting" : "auth.forgot.submit")}
            </Button>
          </form>
        </>
      )}
      <p className="fgw-auth__links">
        <Link href={ROUTES.login}>{tw("auth.forgot.toLogin")}</Link>
      </p>
    </AuthCard>
  );
}
