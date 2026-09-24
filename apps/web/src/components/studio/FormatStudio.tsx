"use client";

import type { StudioFormat } from "@fastgram/contracts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@fastgram/ui";
import { useState } from "react";
import { tw } from "@/lib/i18n/t";
import { StudioCreate } from "./StudioCreate";
import { StudioRemix } from "./StudioRemix";

/**
 * Un formato base del Studio: `Create New` y `Remix` (`F-071`, `F-072`).
 * El panel de Remix se monta al abrirlo (hace fetch a Inspiration).
 */
export function FormatStudio({ format }: { readonly format: StudioFormat }) {
  const [tab, setTab] = useState("create");
  const [remixSeen, setRemixSeen] = useState(false);
  return (
    <Tabs
      value={tab}
      defaultValue="create"
      onValueChange={(value) => {
        setTab(value);
        if (value === "remix") setRemixSeen(true);
      }}
    >
      <TabsList aria-label={tw("studio.modes")}>
        <TabsTrigger value="create">{tw("studio.mode.create")}</TabsTrigger>
        <TabsTrigger value="remix">{tw("studio.mode.remix")}</TabsTrigger>
      </TabsList>
      <TabsContent value="create">
        <div className="mt-4">
          <StudioCreate format={format} />
        </div>
      </TabsContent>
      <TabsContent value="remix">
        <div className="mt-4">{remixSeen && <StudioRemix />}</div>
      </TabsContent>
    </Tabs>
  );
}
