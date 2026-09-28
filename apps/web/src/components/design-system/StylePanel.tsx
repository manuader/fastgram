"use client";

import type { DesignSystemResource } from "@fastgram/contracts";
import { Button, Textarea } from "@fastgram/ui";
import { useState } from "react";

import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw, type CopyKey } from "@/lib/i18n/t";

import { useUpdateDesignSystem } from "./api";

type Style = NonNullable<DesignSystemResource["style"]>;
type ListField = "values" | "compositionRules" | "dos" | "donts";

const LIST_FIELDS: readonly [ListField, CopyKey, number][] = [
  ["values", "designSystem.style.values", 8],
  ["compositionRules", "designSystem.style.rules", 10],
  ["dos", "designSystem.style.dos", 8],
  ["donts", "designSystem.style.donts", 8],
];

const ORIGIN_COPY: Readonly<Record<Style["origin"], CopyKey>> = {
  model: "designSystem.style.origin.model",
  heuristic: "designSystem.style.origin.heuristic",
  owner: "designSystem.style.origin.owner",
};

const lines = (text: string, max: number): string[] =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "")
    .slice(0, max)
    .map((l) => l.slice(0, 200));

/**
 * El resumen de estilo: voz, valores, tagline, reglas de composición y
 * do/don't. Es lo que entra al prompt de la copy (acotado), así que se puede
 * corregir a mano: una línea por ítem.
 */
export function StylePanel({ ds }: { readonly ds: DesignSystemResource }) {
  const update = useUpdateDesignSystem(ds.id);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const style = ds.style;

  function startEditing() {
    setDraft({
      voice: style?.voice ?? "",
      tagline: style?.tagline ?? "",
      language: style?.language ?? "",
      values: (style?.values ?? []).join("\n"),
      compositionRules: (style?.compositionRules ?? []).join("\n"),
      dos: (style?.dos ?? []).join("\n"),
      donts: (style?.donts ?? []).join("\n"),
    });
  }

  return (
    <div className="flex flex-col gap-2" aria-label={tw("designSystem.style.title")}>
      <h3 className="m-0 text-base font-semibold">{tw("designSystem.style.title")}</h3>
      {draft === null ? (
        style === null ? (
          <p className="fgw-brand__note">{tw("designSystem.style.none")}</p>
        ) : (
          <>
            <p className="fgw-brand__note m-0">{tw(ORIGIN_COPY[style.origin])}</p>
            {style.voice !== "" && (
              <p>
                <strong>{tw("designSystem.style.voice")}:</strong> {style.voice}
              </p>
            )}
            {style.tagline !== null && (
              <p>
                <strong>{tw("designSystem.style.tagline")}:</strong> “{style.tagline}”
              </p>
            )}
            {LIST_FIELDS.map(([field, label]) =>
              style[field].length === 0 ? null : (
                <div key={field}>
                  <strong>{tw(label)}</strong>
                  <ul className="m-0 mb-2 pl-5 text-sm">
                    {style[field].map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              ),
            )}
          </>
        )
      ) : (
        <div className="flex flex-col gap-3">
          <label className="fgw-brand-field">
            <span>{tw("designSystem.style.voice")}</span>
            <Textarea
              value={draft["voice"] ?? ""}
              maxLength={400}
              rows={2}
              onChange={(e) => {
                setDraft({ ...draft, voice: e.target.value });
              }}
            />
          </label>
          <label className="fgw-brand-field">
            <span>{tw("designSystem.style.tagline")}</span>
            <Textarea
              value={draft["tagline"] ?? ""}
              maxLength={200}
              rows={1}
              onChange={(e) => {
                setDraft({ ...draft, tagline: e.target.value });
              }}
            />
          </label>
          {LIST_FIELDS.map(([field, label, max]) => (
            <label key={field} className="fgw-brand-field">
              <span>
                {tw(label)} · {tw("designSystem.style.onePerLine")}
              </span>
              <Textarea
                value={draft[field] ?? ""}
                rows={3}
                onChange={(e) => {
                  setDraft({ ...draft, [field]: e.target.value });
                }}
                aria-describedby={undefined}
                data-max={max}
              />
            </label>
          ))}
        </div>
      )}
      {update.isError && <ApiErrorState error={update.error} />}
      <div className="fgw-brand-section__actions">
        {draft === null ? (
          <Button size="sm" variant="secondary" onClick={startEditing}>
            {tw("designSystem.style.edit")}
          </Button>
        ) : (
          <>
            <Button
              size="sm"
              loading={update.isPending}
              onClick={() => {
                const tagline = (draft["tagline"] ?? "").trim();
                const language = (draft["language"] ?? "").trim();
                update.mutate(
                  {
                    style: {
                      voice: (draft["voice"] ?? "").trim().slice(0, 400),
                      tagline: tagline === "" ? null : tagline.slice(0, 200),
                      language: language === "" ? null : language,
                      values: lines(draft["values"] ?? "", 8),
                      compositionRules: lines(draft["compositionRules"] ?? "", 10),
                      dos: lines(draft["dos"] ?? "", 8),
                      donts: lines(draft["donts"] ?? "", 8),
                    },
                  },
                  {
                    onSuccess: () => {
                      setDraft(null);
                    },
                  },
                );
              }}
            >
              {tw("designSystem.save")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDraft(null);
              }}
            >
              {tw("designSystem.cancel")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
