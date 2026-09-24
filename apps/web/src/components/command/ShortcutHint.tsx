"use client";

import { useEffect, useState } from "react";

/**
 * `⌘K` en Apple, `Ctrl K` en el resto. Arranca en `⌘K` en servidor y cliente
 * y se corrige en un efecto: leer `navigator` en el render rompería la
 * hidratación.
 */
export function ShortcutHint({ className }: { className?: string }) {
  const [apple, setApple] = useState(true);
  useEffect(() => {
    const platform =
      (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
        ?.platform ?? navigator.platform;
    setApple(/mac|iphone|ipad|ipod/i.test(platform));
  }, []);
  return (
    <kbd
      className={className === undefined ? "fgw-kbd" : `fgw-kbd ${className}`}
      aria-hidden="true"
    >
      {apple ? "⌘K" : "Ctrl K"}
    </kbd>
  );
}
