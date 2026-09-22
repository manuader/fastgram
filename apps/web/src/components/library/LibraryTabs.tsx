"use client";

import { EmptyState, Tabs, TabsContent, TabsList, TabsTrigger } from "@fastgram/ui";
import { MyContentTab } from "./MyContentTab";
import { tw } from "@/lib/i18n/t";

/**
 * Las tres tabs de la Library · FR-100 (PRD:332, PRD:1601-1620).
 *
 * `My Content` está cableada contra `GET /content`. `My Posts` y
 * `My Media Bank` **no**, y eso se dice en la tab en vez de dejarla en blanco:
 * `GET /posts` y `GET /media` existen y sirven datos, así que el hueco es de
 * esta tarea, no del contrato. Quien siga tiene el mismo patrón a la vista en
 * `MyContentTab` y `lib/library/content.ts`.
 *
 * Las tabs no están en la URL. El PRD las describe como tabs y no documenta un
 * path por tab (§3.1 lista `/library` a secas), así que meterlas en la ruta
 * sería inventar contrato de navegación — pero FR-100.1 sí documenta
 * parámetros de contexto (`?influencerId=&from=`), que son de Media Bank y
 * quedan para quien la construya.
 */
export function LibraryTabs() {
  return (
    <Tabs defaultValue="content" className="fgw-library-tabs">
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
        <MyContentTab />
      </TabsContent>

      <TabsContent value="media">
        <EmptyState
          bordered
          title={tw("library.tab.notWired", { tab: tw("library.tab.myMediaBank") })}
          description={tw("library.tab.notWiredDescription")}
        />
      </TabsContent>
    </Tabs>
  );
}
