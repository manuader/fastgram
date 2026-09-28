"use client";

import type { DesignSystemResource } from "@fastgram/contracts";
import { Button } from "@fastgram/ui";
import { useState } from "react";

import { ApiErrorState } from "@/components/library/ApiErrorState";
import { tw } from "@/lib/i18n/t";

import { useUpdateDesignSystem } from "./api";

interface Swatch {
  readonly name: string;
  readonly hex: string;
}

/**
 * La paleta: swatches con nombre y `#hex`, los roles que usa el contenido
 * (superficie oscura, texto sobre oscuro, acentos) y edición. Editar reemplaza
 * los colores y el servidor recalcula los roles por nombre.
 */
export function PalettePanel({ ds }: { readonly ds: DesignSystemResource }) {
  const update = useUpdateDesignSystem(ds.id);
  const [editing, setEditing] = useState<Swatch[] | null>(null);
  // Los alias repiten un color con otro nombre: se muestran una vez, con su nombre.
  const unique = ds.palette.filter((c) => c.aliasOf === null);
  const shown = unique.length > 0 ? unique : ds.palette;
  const roles: readonly [string, string | null][] = [
    [tw("designSystem.palette.surfaceDark"), ds.semantic.surfaceDark],
    [tw("designSystem.palette.surfaceLight"), ds.semantic.surfaceLight],
    [tw("designSystem.palette.textOnDark"), ds.semantic.textOnDark],
    [tw("designSystem.palette.accents"), ds.semantic.accents.join(" · ") || null],
  ];

  return (
    <div className="flex flex-col gap-2" aria-label={tw("designSystem.palette.title")}>
      <h3 className="m-0 text-base font-semibold">{tw("designSystem.palette.title")}</h3>
      {editing === null ? (
        <>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2 p-0">
            {shown.map((c) => (
              <li key={c.name} className="flex flex-col gap-1 text-xs">
                <span
                  className="block h-12 w-full rounded-md border border-border"
                  style={{ background: c.hex }}
                  aria-hidden="true"
                />
                <span className="font-mono">{c.hex}</span>
                <span className="truncate text-text-muted">
                  {c.name.replace(/^--/u, "")}
                </span>
              </li>
            ))}
          </ul>
          <dl className="m-0 grid grid-cols-2 gap-x-4 gap-y-1 text-sm [&_dd]:m-0 [&_dt]:text-text-muted">
            {roles.map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value ?? tw("designSystem.palette.none")}</dd>
              </div>
            ))}
          </dl>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setEditing(shown.map((c) => ({ name: c.name, hex: c.hex })));
            }}
          >
            {tw("designSystem.palette.edit")}
          </Button>
        </>
      ) : (
        <>
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(7.5rem,1fr))] gap-2 p-0">
            {editing.map((c, i) => (
              <li key={`${c.name}-${String(i)}`} className="flex flex-col gap-1 text-xs">
                <input
                  type="color"
                  value={c.hex.toLowerCase()}
                  aria-label={tw("designSystem.palette.colorOf", { name: c.name })}
                  onChange={(e) => {
                    const next = [...editing];
                    next[i] = { ...c, hex: e.target.value.toUpperCase() };
                    setEditing(next);
                  }}
                />
                <span className="truncate text-text-muted">
                  {c.name.replace(/^--/u, "")}
                </span>
                <button
                  type="button"
                  className="self-start text-text-muted"
                  aria-label={tw("designSystem.palette.remove", { name: c.name })}
                  disabled={editing.length <= 2}
                  onClick={() => {
                    setEditing(editing.filter((_, j) => j !== i));
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
          {update.isError && <ApiErrorState error={update.error} />}
          <div className="fgw-brand-section__actions">
            <Button
              size="sm"
              variant="secondary"
              disabled={editing.length >= 24}
              onClick={() => {
                setEditing([
                  ...editing,
                  { name: `--brand-${String(editing.length + 1)}`, hex: "#888888" },
                ]);
              }}
            >
              {tw("designSystem.palette.add")}
            </Button>
            <Button
              size="sm"
              loading={update.isPending}
              onClick={() => {
                // Los alias (`--surface-dark` → `--focus-ink`) viajan con el color
                // editado de su destino: así los roles no se recalculan por luminancia.
                const byName = new Map(editing.map((c) => [c.name, c.hex]));
                const aliases = ds.palette
                  .filter((c) => c.aliasOf !== null && byName.has(c.aliasOf))
                  .map((c) => ({
                    name: c.name,
                    hex: byName.get(c.aliasOf ?? "") ?? c.hex,
                  }));
                update.mutate(
                  {
                    palette: [...editing, ...aliases]
                      .slice(0, 48)
                      .map((c) => ({ name: c.name, hex: c.hex })),
                  },
                  {
                    onSuccess: () => {
                      setEditing(null);
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
                setEditing(null);
              }}
            >
              {tw("designSystem.cancel")}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
