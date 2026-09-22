"use client";

import { EmptyState, Tabs, TabsContent, TabsList, TabsTrigger } from "@fastgram/ui";
import { useState } from "react";
import { MyContentTab } from "./MyContentTab";
import { MyMediaBankTab } from "./MyMediaBankTab";
import { tw } from "@/lib/i18n/t";

const DEFAULT_TAB = "content";

/**
 * Las tres tabs de la Library · FR-100 (PRD:332, PRD:1601-1626).
 *
 * `My Content` y `My Media Bank` están cableadas contra `GET /content` y
 * `GET /media`. `My Posts` no, y eso se dice en la tab en vez de dejarla en
 * blanco: `GET /posts` existe y sirve datos, así que el hueco es de la tarea,
 * no del contrato (`P2-LIB-001`).
 *
 * ## El panel se monta cuando se abre, no antes
 *
 * `TabsContent` de `@fastgram/ui` **renderiza siempre** su contenido y lo tapa
 * con `hidden`, que es lo correcto para un panel de texto. Con dos tabs que
 * hacen fetch deja de serlo: abrir `/library` dispararía `GET /content` **y**
 * `GET /media` aunque sólo se mire una, o sea el doble de peticiones contra el
 * límite de §9.6 para enseñar lo mismo.
 *
 * Así que cada panel se monta la primera vez que se abre. Se monta, no se
 * desmonta: una vez visitado se queda, porque `useContentList` corre con
 * `staleTime: 0` y desmontar al cambiar de tab convertiría cada ida y vuelta
 * entre pestañas en dos peticiones más.
 *
 * Las tabs no están en la URL. El PRD las describe como tabs y no documenta un
 * path por tab (§3.1 lista `/library` a secas), así que meterlas en la ruta
 * sería inventar contrato de navegación — pero FR-100.1 sí documenta
 * parámetros de contexto (`?influencerId=&from=`), que son de Media Bank y
 * quedan para `P2-MEDIA-008`.
 */
export function LibraryTabs() {
  const [active, setActive] = useState(DEFAULT_TAB);
  const [visited, setVisited] = useState<readonly string[]>([DEFAULT_TAB]);

  function open(value: string): void {
    setActive(value);
    setVisited((current) => (current.includes(value) ? current : [...current, value]));
  }

  return (
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
      </TabsList>

      <TabsContent value="posts">
        <EmptyState
          bordered
          title={tw("library.tab.notWired", { tab: tw("library.tab.myPosts") })}
          description={tw("library.tab.notWiredDescription")}
        />
      </TabsContent>

      <TabsContent value="content">
        {visited.includes("content") && <MyContentTab />}
      </TabsContent>

      <TabsContent value="media">
        {visited.includes("media") && <MyMediaBankTab />}
      </TabsContent>
    </Tabs>
  );
}
