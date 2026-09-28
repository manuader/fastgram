"use client";

import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogHeader,
  DialogTitle,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@fastgram/ui";
import { useState } from "react";
import { tw } from "@/lib/i18n/t";
import { SourcesPanel } from "./SourcesPanel";
import { UploadForm } from "./UploadForm";

export interface ImportDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

/**
 * Sumar assets a la biblioteca global: un archivo propio (con su licencia
 * declarada) o resultados de una fuente externa. El diálogo **no** se cierra
 * solo al terminar: se suelen sumar varios seguidos, y el resultado de cada
 * import (encolado / duplicado / rechazado) es lo que hay que leer.
 *
 * `closeOnOverlayClick` apagado: un click fuera a mitad de un formulario de
 * licencia largo tiraría lo escrito.
 */
export function ImportDialog({ open, onClose }: ImportDialogProps) {
  // Las fuentes se piden recién al abrir su pestaña (y quedan montadas
  // después): quien sólo sube un archivo no gasta un `GET /library/sources`,
  // y volver a «From sources» no pierde la búsqueda.
  const [sourcesVisited, setSourcesVisited] = useState(false);
  return (
    <Dialog open={open} onClose={onClose} size="xl" closeOnOverlayClick={false}>
      <DialogHeader>
        <DialogTitle>{tw("globalLibrary.import.title")}</DialogTitle>
        <DialogClose label={tw("globalLibrary.close")} />
      </DialogHeader>
      <DialogBody>
        <Tabs
          defaultValue="upload"
          onValueChange={(v) => {
            if (v === "sources") setSourcesVisited(true);
          }}
        >
          <TabsList aria-label={tw("globalLibrary.import.title")}>
            <TabsTrigger value="upload">
              {tw("globalLibrary.import.tab.upload")}
            </TabsTrigger>
            <TabsTrigger value="sources">
              {tw("globalLibrary.import.tab.sources")}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="upload">
            <div className="pt-4">
              <UploadForm />
            </div>
          </TabsContent>
          <TabsContent value="sources">
            <div className="pt-4">{sourcesVisited && <SourcesPanel />}</div>
          </TabsContent>
        </Tabs>
      </DialogBody>
    </Dialog>
  );
}
