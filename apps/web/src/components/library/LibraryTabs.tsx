"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@fastgram/ui";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { MyContentTab } from "./MyContentTab";
import { MyMediaBankTab } from "./MyMediaBankTab";
import { MyPostsTab } from "./MyPostsTab";
import { BrandAudioPanel } from "@/components/library/audio/BrandAudioPanel";
import { tw } from "@/lib/i18n/t";
import { readLibraryDeepLink } from "@/lib/media/deep-link";

const DEFAULT_TAB = "content";

/**
 * Las tres tabs de la Library · FR-100 (PRD:332, PRD:1601-1626).
 *
 * Las tres están cableadas: `GET /posts`, `GET /content` y `GET /media`.
 *
 * ## El panel se monta cuando se abre, no antes
 *
 * `TabsContent` de `@fastgram/ui` **renderiza siempre** su contenido y lo tapa
 * con `hidden`, que es lo correcto para un panel de texto. Con tres tabs que
 * hacen fetch deja de serlo: abrir `/library` dispararía `GET /content`,
 * `GET /media` **y** `GET /posts` aunque sólo se mire una, o sea el triple de
 * peticiones contra el límite de §9.6 para enseñar lo mismo.
 *
 * Así que cada panel se monta la primera vez que se abre. Se monta, no se
 * desmonta: una vez visitado se queda, porque `useContentList` corre con
 * `staleTime: 0` y desmontar al cambiar de tab convertiría cada ida y vuelta
 * entre pestañas en dos peticiones más.
 *
 * Las tabs no están en la URL. El PRD las describe como tabs y no documenta un
 * path por tab (§3.1 lista `/library` a secas).
 *
 * ## Deep links (`FR-100.1`, `P2-MEDIA-008`, sprint 7)
 *
 * `?from=<path interno>&focus=<mediaId>` abre directo en el Media Bank, con un
 * «Back» a `from` y el asset `focus` resaltado. `from` se valida como path
 * interno (`safeReturnPath`): nada de open redirects. `?tab=` elige la pestaña.
 * `useSearchParams` exige un `Suspense` por encima para el render estático: lo
 * pone este mismo componente.
 */
export function LibraryTabs() {
  return (
    <Suspense fallback={null}>
      <LibraryTabsWithParams />
    </Suspense>
  );
}

function LibraryTabsWithParams() {
  const params = useSearchParams();
  const link = readLibraryDeepLink(params ?? new URLSearchParams());
  const initial = link.tab ?? DEFAULT_TAB;
  const [active, setActive] = useState<string>(initial);
  const [visited, setVisited] = useState<readonly string[]>([initial]);

  function open(value: string): void {
    setActive(value);
    setVisited((current) => (current.includes(value) ? current : [...current, value]));
  }

  return (
    <>
      {link.from !== null && (
        <Link
          href={link.from}
          className="fg-focusable mb-3 inline-block text-sm text-accent underline"
        >
          {tw("mediaBank.back")}
        </Link>
      )}
      <Tabs
        value={active}
        defaultValue={DEFAULT_TAB}
        onValueChange={open}
        className="fgw-library-tabs"
      >
        <TabsList aria-label={tw("library.title")}>
          <TabsTrigger value="posts">{tw("library.tab.myPosts")}</TabsTrigger>
          <TabsTrigger value="content">{tw("library.tab.myContent")}</TabsTrigger>
          <TabsTrigger value="media">{tw("library.tab.myMediaBank")}</TabsTrigger>
          {/* Sprint 7: la biblioteca de audio de la marca (agente B). */}
          <TabsTrigger value="audio">{tw("audio.panel.title")}</TabsTrigger>
        </TabsList>

        <TabsContent value="posts">
          {visited.includes("posts") && <MyPostsTab />}
        </TabsContent>

        <TabsContent value="content">
          {visited.includes("content") && <MyContentTab />}
        </TabsContent>

        <TabsContent value="media">
          {visited.includes("media") && <MyMediaBankTab focusId={link.focus} />}
        </TabsContent>

        <TabsContent value="audio">
          {visited.includes("audio") && <BrandAudioPanel />}
        </TabsContent>
      </Tabs>
    </>
  );
}
