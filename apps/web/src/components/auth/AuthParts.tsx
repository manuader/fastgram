import Link from "next/link";
import type { ReactNode } from "react";
import { Input, type InputProps } from "@fastgram/ui";
import { tw } from "@/lib/i18n/t";
import type { AuthErrorPresentation } from "@/lib/auth/auth-client";
import { ROUTES } from "@/lib/nav/routes";

/**
 * La cáscara de las pantallas de identidad: un título (`h1`, el único de la
 * página) y lo demás. `aria-labelledby` hace que el lector de pantalla anuncie
 * la sección por su título y no como "región".
 */
export function AuthCard({
  titleId,
  title,
  children,
}: {
  readonly titleId: string;
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <section className="fgw-auth" aria-labelledby={titleId}>
      <h1 id={titleId} className="fgw-auth__title">
        {title}
      </h1>
      {children}
    </section>
  );
}

/**
 * Un campo con su `<label>` de verdad (no un placeholder que desaparece al
 * escribir) y, si hay, una pista enlazada por `aria-describedby`.
 */
export function AuthField({
  id,
  label,
  hint,
  ...input
}: InputProps & { readonly id: string; readonly label: string; readonly hint?: string }) {
  const hintId = `${id}-hint`;
  return (
    <div className="fgw-auth__field">
      <label htmlFor={id} className="fgw-auth__label">
        {label}
      </label>
      <Input
        id={id}
        {...input}
        {...(hint === undefined ? {} : { "aria-describedby": hintId })}
      />
      {hint !== undefined && (
        <p id={hintId} className="fgw-auth__hint">
          {hint}
        </p>
      )}
    </div>
  );
}

/**
 * El error de un envío. `role="alert"` lo anuncia en cuanto aparece, sin mover
 * el foco del campo que el usuario va a tener que corregir.
 */
export function AuthAlert({ problem }: { readonly problem: AuthErrorPresentation }) {
  return (
    <div className="fgw-auth__alert" role="alert">
      <p>{tw(problem.key, problem.vars)}</p>
      {problem.action === "login" && (
        <Link href={ROUTES.login}>{tw("auth.error.emailTakenAction")}</Link>
      )}
      {problem.action === "requestNewLink" && (
        <Link href={ROUTES.forgotPassword}>{tw("auth.reset.requestNew")}</Link>
      )}
    </div>
  );
}
