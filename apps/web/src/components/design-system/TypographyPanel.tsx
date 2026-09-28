"use client";

import type { DesignSystemResource } from "@fastgram/contracts";
import { Checkbox } from "@fastgram/ui";
import { useEffect } from "react";

import { ApiErrorState } from "@/components/library/ApiErrorState";
import { cssFontFamily, googleFontsUrl } from "@/lib/editor/fonts";
import { tw, type CopyKey } from "@/lib/i18n/t";

import { useBrandFontFace, useUpdateDesignSystem } from "./api";

type Family = DesignSystemResource["families"][number];

const SPECIMEN = "El punto donde todo cambia · Aa Bb Rr 0123";

const ORIGIN_COPY: Readonly<Record<Family["origin"], CopyKey>> = {
  file: "designSystem.type.origin.file",
  google: "designSystem.type.origin.google",
  stack: "designSystem.type.origin.stack",
};

/**
 * Las familias del design system con un specimen **en la fuente real** (los
 * bytes se cargan con `FontFace`) y, para las que necesitan licencia, el
 * tilde «tengo licencia». Sin licencia, el specimen muestra además la familia
 * libre con la que el render la reemplaza.
 */
export function TypographyPanel({ ds }: { readonly ds: DesignSystemResource }) {
  const update = useUpdateDesignSystem(ds.id);
  const families = ds.families.filter((f) => f.origin !== "stack");
  const fallbacks = [...new Set(families.map((f) => f.fallback))];
  const url = googleFontsUrl(fallbacks as Parameters<typeof googleFontsUrl>[0]);

  // Las familias libres del render (el reemplazo) salen de Google Fonts, como
  // en el editor: así el specimen del reemplazo es fiel.
  useEffect(() => {
    if (url === null || typeof document === "undefined") return;
    if (document.querySelector(`link[data-fg-ds-fonts="${url}"]`) !== null) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = url;
    link.dataset["fgDsFonts"] = url;
    document.head.appendChild(link);
  }, [url]);

  const title = ds.textDefaults.title;
  const body = ds.textDefaults.body;

  return (
    <div className="flex flex-col gap-2" aria-label={tw("designSystem.type.title")}>
      <h3 className="m-0 text-base font-semibold">{tw("designSystem.type.title")}</h3>
      <p className="fgw-brand__note m-0">
        {tw("designSystem.type.defaults", {
          title: title.displayName,
          body: body.displayName,
        })}
      </p>
      {families.length === 0 ? (
        <p className="fgw-brand__note">{tw("designSystem.type.none")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-4 p-0">
          {families.map((f) => (
            <FamilyRow
              key={f.id}
              dsId={ds.id}
              family={f}
              disabled={update.isPending}
              onLicense={(checked) => {
                update.mutate({ fontLicenses: { [f.id]: checked } });
              }}
            />
          ))}
        </ul>
      )}
      {update.isError && <ApiErrorState error={update.error} />}
    </div>
  );
}

function FamilyRow({
  dsId,
  family,
  disabled,
  onLicense,
}: {
  readonly dsId: string;
  readonly family: Family;
  readonly disabled: boolean;
  readonly onLicense: (checked: boolean) => void;
}) {
  const face =
    family.faces.find((f) => f.style === "normal" && f.fileRef !== null) ??
    family.faces.find((f) => f.fileRef !== null) ??
    null;
  const loaded = useBrandFontFace(
    dsId,
    face?.fileRef ?? null,
    family.id,
    face?.weight ?? 400,
    face?.style ?? "normal",
  );
  const fallbackCss = cssFontFamily(
    family.fallback as Parameters<typeof cssFontFamily>[0],
  );
  const ownCss =
    loaded.state === "ready" ? `"${loaded.cssFamily}", ${fallbackCss}` : fallbackCss;

  return (
    <li
      className="flex flex-col gap-1 rounded-md border border-border p-3"
      data-testid={`ds-family-${family.id}`}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <strong>{family.name}</strong>
        <span className="fgw-brand__note">
          {tw(ORIGIN_COPY[family.origin])} ·{" "}
          {family.weights.length === 0 ? "—" : family.weights.join(" / ")}
        </span>
      </div>
      {face !== null && (
        <p
          className="m-0 text-2xl leading-tight"
          style={{
            fontFamily: ownCss,
            fontWeight: face.weight,
            fontStyle: face.style,
          }}
        >
          {loaded.state === "loading"
            ? tw("designSystem.type.loading")
            : loaded.state === "error"
              ? tw("designSystem.type.loadError")
              : SPECIMEN}
        </p>
      )}
      {!family.usable && (
        <p className="m-0 text-base text-text-muted" style={{ fontFamily: fallbackCss }}>
          {tw("designSystem.type.rendersAs", { name: family.fallbackName })} — {SPECIMEN}
        </p>
      )}
      {family.license === "needs_confirmation" && (
        <Checkbox
          label={tw("designSystem.type.license")}
          checked={family.licenseConfirmed}
          disabled={disabled}
          onChange={(e) => {
            onLicense(e.currentTarget.checked);
          }}
        />
      )}
    </li>
  );
}
