"use client";

import { BRAND_OCR_MAX_IMAGES } from "@fastgram/contracts";
import { Button, Spinner } from "@fastgram/ui";
import { useId, useRef, useState, type ChangeEvent } from "react";
import { presentError } from "@/lib/api/error-presentation";
import {
  dataUrlBytes,
  downscaleImage,
  SCREENSHOT_MAX_BYTES,
  SCREENSHOT_MAX_SIDE,
  useReadScreenshot,
} from "@/lib/brand/intel";
import { tw } from "@/lib/i18n/t";

const ACCEPT = ["image/png", "image/jpeg", "image/webp"];

export interface ScreenshotReader {
  readonly busy: boolean;
  readonly progress: { readonly done: number; readonly total: number } | null;
  readonly problems: readonly string[];
  read(files: readonly File[]): Promise<void>;
}

/**
 * Lee 1–5 capturas de a una (`POST /brand/ocr`; el cuerpo de la API topa en
 * 1 MiB): cada una se reduce a JPEG ≤ {@link SCREENSHOT_MAX_SIDE}px en el
 * navegador y el texto que vuelve se entrega a `onText`. Nada se guarda.
 */
export function useScreenshotReader(onText: (text: string) => void): ScreenshotReader {
  const ocr = useReadScreenshot();
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [problems, setProblems] = useState<string[]>([]);

  async function read(files: readonly File[]) {
    const picked = files.slice(0, BRAND_OCR_MAX_IMAGES);
    const found: string[] = [];
    const issues: string[] =
      files.length > BRAND_OCR_MAX_IMAGES
        ? [tw("brand.screenshots.tooMany", { max: BRAND_OCR_MAX_IMAGES })]
        : [];
    setProblems([]);
    setProgress({ done: 0, total: picked.length });
    for (const [index, file] of picked.entries()) {
      const n = index + 1;
      try {
        if (!ACCEPT.includes(file.type)) {
          issues.push(tw("brand.screenshots.badType", { n }));
          continue;
        }
        let dataUrl = await downscaleImage(file, SCREENSHOT_MAX_SIDE, "image/jpeg", 0.85);
        if (dataUrlBytes(dataUrl) > SCREENSHOT_MAX_BYTES) {
          dataUrl = await downscaleImage(file, SCREENSHOT_MAX_SIDE, "image/jpeg", 0.6);
        }
        if (dataUrlBytes(dataUrl) > SCREENSHOT_MAX_BYTES) {
          issues.push(tw("brand.screenshots.tooBig", { n }));
          continue;
        }
        const result = await ocr.mutateAsync({
          contentType: "image/jpeg",
          data: dataUrl.slice(dataUrl.indexOf(",") + 1),
        });
        if (result.text.trim() === "") issues.push(tw("brand.screenshots.noText", { n }));
        else found.push(result.text.trim());
      } catch (error: unknown) {
        const p = presentError(error);
        issues.push(
          `${tw("brand.screenshots.failed", { n })} ${tw(p.titleKey, p.titleVars)}`,
        );
      } finally {
        setProgress({ done: n, total: picked.length });
      }
    }
    if (found.length > 0) onText(found.join("\n\n"));
    setProblems(issues);
    setProgress(null);
  }

  return { busy: progress !== null, progress, problems, read };
}

/**
 * El botón «Upload screenshots» del tier D (`P1-BRAND-014`). Estados:
 * leyendo (N de M), problemas por captura, listo (el texto aparece en el
 * campo de la bio para revisarlo antes de mandar).
 */
export function ScreenshotPicker({
  reader,
  disabled,
}: {
  readonly reader: ScreenshotReader;
  readonly disabled: boolean;
}) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="fgw-brand-field">
      <p className="fgw-brand-field__hint m-0" id={`${id}-hint`}>
        {tw("brand.screenshots.hint", { max: BRAND_OCR_MAX_IMAGES })}
      </p>
      <input
        ref={input}
        type="file"
        multiple
        accept={ACCEPT.join(",")}
        className="fg-visually-hidden"
        aria-describedby={`${id}-hint`}
        onChange={(e: ChangeEvent<HTMLInputElement>) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = "";
          if (files.length > 0) void reader.read(files);
        }}
      />
      <div>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={disabled || reader.busy}
          onClick={() => input.current?.click()}
        >
          {reader.busy && <Spinner size="sm" aria-hidden="true" />}
          {reader.progress === null
            ? tw("brand.screenshots.upload")
            : tw("brand.screenshots.reading", {
                done: reader.progress.done,
                total: reader.progress.total,
              })}
        </Button>
      </div>
      {reader.problems.length > 0 && (
        <ul className="fgw-brand-field__error m-0" role="alert">
          {reader.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
