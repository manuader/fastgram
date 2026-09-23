"use client";

import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { signOut } from "@/lib/auth/auth-client";
import { hardNavigate } from "@/lib/auth/navigate";
import { tw } from "@/lib/i18n/t";
import { ROUTES } from "@/lib/nav/routes";
import { AuthCard } from "./AuthParts";

/**
 * `/logout` · F-003.
 *
 * Sale al montar y lleva al login. Si el `POST` falla (red caída, `403` por
 * CSRF) no se finge: se dice que no se pudo y se ofrece reintentar — un
 * "saliste" falso con la cookie todavía puesta es peor que un error. El
 * handler borra la cookie aunque la **API** falle; lo que no puede borrar es
 * una cookie de una petición que no le llegó.
 *
 * El `ref` evita el doble `POST` de `StrictMode` en desarrollo.
 */
export function LogoutScreen() {
  const id = useId();
  const started = useRef(false);
  const [failed, setFailed] = useState(false);

  async function run() {
    setFailed(false);
    try {
      await signOut();
      hardNavigate(ROUTES.login);
    } catch {
      setFailed(true);
    }
  }

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run();
  }, []);

  return (
    <AuthCard titleId={`${id}-title`} title={tw("auth.logout.title")}>
      <div aria-live="polite">
        {failed && (
          <div className="fgw-auth__alert" role="alert">
            <p>{tw("common.somethingWentWrong")}</p>
            <button
              type="button"
              className="fgw-auth__linkbutton"
              onClick={() => void run()}
            >
              {tw("common.tryAgain")}
            </button>
          </div>
        )}
      </div>
      <p className="fgw-auth__links">
        <Link href={ROUTES.login}>{tw("auth.logout.toLogin")}</Link>
      </p>
    </AuthCard>
  );
}
