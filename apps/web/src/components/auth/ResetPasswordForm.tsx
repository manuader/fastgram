"use client";

import { Button } from "@fastgram/ui";
import Link from "next/link";
import { useId, useState, type FormEvent } from "react";
import {
  completePasswordReset,
  presentAuthError,
  type AuthErrorPresentation,
} from "@/lib/auth/auth-client";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { AuthAlert, AuthCard, AuthField } from "./AuthParts";

/**
 * `/reset-password?token=…` · PRD §15.3 (INFERRED). El enlace lo arma el email
 * que manda `apps/api`; esta pantalla sólo toma el `token` de la URL y la
 * contraseña nueva. Un `400` es "el enlace no vale" (vencido, usado o
 * inventado), con la salida de pedir otro.
 *
 * No inicia sesión: tras el `204` se pide entrar con la contraseña nueva. Es
 * lo que el contrato da (`204`, sin token) y además es lo prudente — un enlace
 * de email reenviado no debería dejar a nadie adentro.
 */
export function ResetPasswordForm({ token }: { readonly token: string | null }) {
  const id = useId();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [problem, setProblem] = useState<AuthErrorPresentation | null>(
    token === null ? { key: "auth.reset.invalidLink", action: "requestNewLink" } : null,
  );

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || token === null) return;
    if (password === "") {
      setProblem({ key: "auth.error.missingFields" });
      return;
    }
    setBusy(true);
    setProblem(null);
    try {
      await completePasswordReset({ token, newPassword: password });
      setDone(true);
    } catch (error) {
      setProblem(presentAuthError(error, "reset"));
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <AuthCard titleId={`${id}-title`} title={tw("auth.reset.title")}>
        <p role="status" className="fgw-auth__body">
          {tw("auth.reset.done")}
        </p>
        <p className="fgw-auth__links">
          <Link href={ROUTES.login}>{tw("auth.login.submit")}</Link>
        </p>
      </AuthCard>
    );
  }

  return (
    <AuthCard titleId={`${id}-title`} title={tw("auth.reset.title")}>
      <form
        className="fgw-auth__form"
        onSubmit={(event) => void submit(event)}
        noValidate
        aria-busy={busy || undefined}
      >
        <AuthField
          id={`${id}-password`}
          label={tw("auth.field.newPassword")}
          hint={tw("auth.field.passwordHint")}
          type="password"
          name="newPassword"
          autoComplete="new-password"
          required
          disabled={token === null}
          value={password}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
        {problem !== null && <AuthAlert problem={problem} />}
        <Button type="submit" loading={busy} disabled={busy || token === null}>
          {tw(busy ? "auth.reset.submitting" : "auth.reset.submit")}
        </Button>
      </form>
    </AuthCard>
  );
}
