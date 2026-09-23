"use client";

import { Button } from "@fastgram/ui";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import {
  presentAuthError,
  signIn,
  type AuthErrorPresentation,
} from "@/lib/auth/auth-client";
import { hardNavigate } from "@/lib/auth/navigate";
import { RETURN_TO_PARAM } from "@/lib/auth/route-policy";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { AuthAlert, AuthCard, AuthField } from "./AuthParts";

export interface LoginFormProps {
  /** Ya saneado por la página (`safeReturnTo`). */
  readonly returnTo: string | null;
  /** §15.2: se llegó acá porque la API no pudo verificar la sesión. */
  readonly sessionUnverified: boolean;
}

/**
 * `/login` · F-002, PRD §15.2.
 *
 * Tras `200` navega (con recarga) a lo que dice el servidor: `/onboarding` si
 * el usuario no tiene workspace, si no el `redirect_url` saneado o `/home`.
 */
export function LoginForm({ returnTo, sessionUnverified }: LoginFormProps) {
  const id = useId();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<AuthErrorPresentation | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (email.trim() === "" || password === "") {
      setProblem({ key: "auth.error.missingFields" });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      const result = await signIn({ email, password, returnTo: returnTo ?? undefined });
      hardNavigate(result.next);
    } catch (error) {
      setProblem(presentAuthError(error, "login"));
      setBusy(false);
    }
  }

  const signupHref =
    returnTo === null
      ? ROUTES.signup
      : `${ROUTES.signup}?${RETURN_TO_PARAM}=${encodeURIComponent(returnTo)}`;

  return (
    <AuthCard titleId={`${id}-title`} title={tw("auth.login.title")}>
      {sessionUnverified && (
        <div className="fgw-auth__alert" role="status">
          <p>{tw("auth.session.unverified")}</p>
          {/* Reintentar = volver a navegar: el middleware verifica otra vez. */}
          <a href={returnTo ?? ROUTES.home}>{tw("common.tryAgain")}</a>
        </div>
      )}
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
        <AuthField
          id={`${id}-password`}
          label={tw("auth.field.password")}
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        {problem !== null && <AuthAlert problem={problem} />}
        <Button type="submit" loading={busy} disabled={busy}>
          {tw(busy ? "auth.login.submitting" : "auth.login.submit")}
        </Button>
      </form>
      <p className="fgw-auth__links">
        <Link href={ROUTES.forgotPassword}>{tw("auth.login.forgot")}</Link>
        <Link href={signupHref}>{tw("auth.login.toSignup")}</Link>
      </p>
    </AuthCard>
  );
}
