"use client";

import { Button } from "@fastgram/ui";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import {
  presentAuthError,
  signUp,
  type AuthErrorPresentation,
} from "@/lib/auth/auth-client";
import { hardNavigate } from "@/lib/auth/navigate";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { AuthAlert, AuthCard, AuthField } from "./AuthParts";

/**
 * `/signup` · F-001, PRD §15.1. Email/password; el SSO de §15.1 no está (no
 * hay proveedor SSO configurado en la API).
 *
 * Tras `201` el usuario ya está dentro (la cookie la puso el servidor) y, sin
 * workspace, el servidor lo manda a `/onboarding`.
 */
export function SignupForm({ returnTo }: { readonly returnTo: string | null }) {
  const id = useId();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<AuthErrorPresentation | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (fullName.trim() === "" || email.trim() === "" || password === "") {
      setProblem({ key: "auth.error.missingFields" });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const result = await signUp({
        fullName,
        email,
        password,
        returnTo: returnTo ?? undefined,
      });
      hardNavigate(result.next);
    } catch (error) {
      setProblem(presentAuthError(error, "signup"));
      setBusy(false);
    }
  }

  return (
    <AuthCard titleId={`${id}-title`} title={tw("auth.signup.title")}>
      <form
        className="fgw-auth__form"
        onSubmit={(event) => void submit(event)}
        noValidate
        aria-busy={busy || undefined}
      >
        <AuthField
          id={`${id}-name`}
          label={tw("auth.field.fullName")}
          type="text"
          name="fullName"
          autoComplete="name"
          required
          value={fullName}
          onChange={(event) => {
            setFullName(event.target.value);
          }}
        />
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
        <AuthField
          id={`${id}-password`}
          label={tw("auth.field.password")}
          hint={tw("auth.field.passwordHint")}
          type="password"
          name="password"
          autoComplete="new-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        {problem !== null && <AuthAlert problem={problem} />}
        <Button type="submit" loading={busy} disabled={busy}>
          {tw(busy ? "auth.signup.submitting" : "auth.signup.submit")}
        </Button>
      </form>
      <p className="fgw-auth__links">
        <Link href={ROUTES.login}>{tw("auth.signup.toLogin")}</Link>
      </p>
    </AuthCard>
  );
}
