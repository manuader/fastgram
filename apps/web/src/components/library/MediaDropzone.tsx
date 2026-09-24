"use client";

import { Button, cn } from "@fastgram/ui";
import { UPLOAD_IMAGE_MAX_MB, UPLOAD_VIDEO_MAX_MB } from "@fastgram/contracts";
import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";
import { tw } from "@/lib/i18n/t";
import { MEDIA_UPLOAD_ACCEPT } from "@/lib/media/upload/queue";

export interface MediaDropTargetHandle {
  /** Abre el diálogo de archivos del sistema. */
  readonly openPicker: () => void;
}

export interface MediaDropTargetProps {
  readonly onFiles: (files: readonly File[]) => void;
  readonly className?: string;
  readonly children: ReactNode;
}

/** ¿El arrastre trae archivos? Arrastrar texto o un enlace no debe iluminar nada. */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

/**
 * El panel entero es la zona de soltar, no sólo el recuadro punteado: quien
 * arrastra 12 fotos desde el Finder las suelta donde cae el cursor, y que la
 * mitad de la pantalla las ignore es un "no pasó nada" sin explicación.
 *
 * Lleva además el único `<input type="file" multiple>` de la pantalla: el
 * botón `Upload` de la barra, el CTA del vacío y el recuadro abren el mismo.
 */
export const MediaDropTarget = forwardRef<MediaDropTargetHandle, MediaDropTargetProps>(
  function MediaDropTarget({ onFiles, className, children }, ref) {
    const inputRef = useRef<HTMLInputElement>(null);
    // Contador y no booleano: `dragleave` salta al pasar sobre cada hijo.
    const depthRef = useRef(0);
    const [over, setOver] = useState(false);

    useImperativeHandle(ref, () => ({
      openPicker: () => {
        inputRef.current?.click();
      },
    }));

    const reset = useCallback(() => {
      depthRef.current = 0;
      setOver(false);
    }, []);

    return (
      <div
        className={cn("relative", className)}
        onDragEnter={(event) => {
          if (!carriesFiles(event)) return;
          event.preventDefault();
          depthRef.current += 1;
          setOver(true);
        }}
        onDragOver={(event) => {
          if (!carriesFiles(event)) return;
          // Sin `preventDefault` en `dragover`, el navegador no dispara `drop`
          // y abre el archivo en la pestaña: la app desaparece.
          event.preventDefault();
          event.dataTransfer.dropEffect = "copy";
        }}
        onDragLeave={() => {
          depthRef.current = Math.max(0, depthRef.current - 1);
          if (depthRef.current === 0) setOver(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          reset();
          const files = Array.from(event.dataTransfer.files);
          if (files.length > 0) onFiles(files);
        }}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={MEDIA_UPLOAD_ACCEPT}
          aria-label={tw("mediaUpload.inputLabel")}
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            // Vaciar el valor: sin esto, elegir otra vez el mismo archivo (un
            // reintento tras un rechazo) no dispara `change`.
            event.target.value = "";
            if (files.length > 0) onFiles(files);
          }}
        />
        {children}
        {over && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 z-overlay flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-accent-subtle"
          >
            <span className="rounded-full bg-surface px-4 py-2 text-sm font-semibold text-text shadow-md">
              {tw("mediaUpload.dropzone.overlay")}
            </span>
          </div>
        )}
      </div>
    );
  },
);

export interface MediaDropzoneProps {
  readonly onBrowse: () => void;
}

/** El recuadro compacto sobre la grid: recuerda que se puede soltar acá. */
export function MediaDropzone({ onBrowse }: MediaDropzoneProps) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-dashed border-border-strong bg-surface-sunken px-4 py-3">
      <div className="flex items-center gap-3">
        <UploadGlyph className="h-5 w-5 text-text-muted" />
        <div>
          <p className="text-sm font-medium text-text">
            {tw("mediaUpload.dropzone.title")}
          </p>
          <p className="text-xs text-text-muted">
            {tw("mediaUpload.dropzone.hint", {
              imageMax: UPLOAD_IMAGE_MAX_MB,
              videoMax: UPLOAD_VIDEO_MAX_MB,
            })}
          </p>
        </div>
      </div>
      <Button variant="secondary" size="sm" onClick={onBrowse}>
        {tw("mediaUpload.dropzone.browse")}
      </Button>
    </div>
  );
}

export function UploadGlyph({ className }: { readonly className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 15V4M7.5 8.5L12 4l4.5 4.5" />
      <path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
    </svg>
  );
}
