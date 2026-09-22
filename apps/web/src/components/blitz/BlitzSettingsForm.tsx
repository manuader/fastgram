"use client";

import { Select, Skeleton, Switch } from "@fastgram/ui";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiErrorState } from "@/components/library/ApiErrorState";
import { SaveStatusBanner, type BannerStatus } from "./SaveStatusBanner";
import { WeightSlider } from "./WeightSlider";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { queryKeys } from "@/lib/api/keys";
import { useAutosave, type SaveOutcome } from "@/lib/blitz/autosave";
import {
  applyMix,
  buildPreferencesPatch,
  GENDER_OPTIONS,
  MIX_COPY,
  MIX_KEYS,
  mixOf,
  RATIO_COPY,
  RATIO_KEYS,
  TEXT_STYLE_COPY,
  TEXT_STYLE_PRESETS,
  isStyleMixOn,
  toDraft,
  useBlitzPreferences,
  useSaveBlitzPreferences,
  type BlockedGroup,
  type PreferencesDraft,
  type RatioKey,
} from "@/lib/blitz/preferences";
import { evenWeights, setWeight, sumWeights } from "@/lib/blitz/weights";
import type { BlitzPreferences, GenderFilter } from "@fastgram/contracts";

const BLOCKED_COPY: Readonly<Record<BlockedGroup, CopyKey>> = {
  contentMix: "prefs.group.contentMix",
  textStyleWeights: "prefs.group.textStyleWeights",
};

const GENDER_COPY: Readonly<Record<string, CopyKey>> = {
  "": "prefs.gender.any",
  man: "prefs.gender.man",
  woman: "prefs.gender.woman",
};

function isGenderFilter(value: string): value is GenderFilter {
  return value === "man" || value === "woman";
}

/**
 * Un porcentaje suelto, campo a campo.
 *
 * Un `{ ...draft, [key]: value }` con `key` de tipo unión deja de comprobar que
 * el campo existe —TypeScript ensancha la clave computada— y un error de tipeo
 * añadiría una propiedad nueva al borrador en vez de fallar. El `switch`
 * exhaustivo es lo que hace que quitar un campo del contrato rompa aquí.
 */
function withRatio(
  draft: PreferencesDraft,
  key: RatioKey,
  value: number,
): PreferencesDraft {
  switch (key) {
    case "remixPercentage":
      return { ...draft, remixPercentage: value };
    case "ownMediaPercentage":
      return { ...draft, ownMediaPercentage: value };
    case "mentionBusinessPercentage":
      return { ...draft, mentionBusinessPercentage: value };
    case "influencerChance":
      return { ...draft, influencerChance: value };
  }
}

/**
 * `/blitz/settings` · FR-055 (PRD:1255-1300), `P2-PREFS-007`.
 *
 * ## Los estados de §19, y el que esta pantalla no tiene
 *
 * `loading` y `error` están. **`empty` no existe acá, y no es un olvido**:
 * `GET /blitz/preferences` sintetiza defaults sin escribir fila (DATA-006), así
 * que un workspace recién creado devuelve preferencias completas. Una pantalla
 * de ajustes vacía sería un fallo del servidor, no un estado del producto.
 *
 * ## Cómo se guarda
 *
 * El planificador está en `lib/blitz/autosave.ts` y el cuerpo del PATCH lo
 * calcula `buildPreferencesPatch` **en el momento de mandarlo**, comparando el
 * borrador contra la última respuesta confirmada del servidor. De ahí salen
 * tres propiedades que no habría con una cola de cuerpos: los cuatro pesos
 * viajan siempre juntos, revertir un cambio lo saca del patch, y la petición
 * que sale después de una ráfaga lleva el estado final y no los intermedios.
 *
 * ## Lo que esta pantalla NO edita, y por qué
 *
 * `angleWeights`. Su regla es que cubra **todos los ángulos activos del
 * workspace** y aquí no hay de dónde sacar esa lista. Un editor sin ella
 * produciría PATCHes que el servidor rechaza siempre, que es peor que no
 * tenerlo. Se dice en pantalla en vez de callarlo.
 */
export function BlitzSettingsForm() {
  const query = useBlitzPreferences();
  const mutation = useSaveBlitzPreferences();
  const queryClient = useQueryClient();

  const [draft, setDraft] = useState<PreferencesDraft | null>(null);
  const [baseline, setBaseline] = useState<PreferencesDraft | null>(null);

  // Los refs son lo que lee el guardado, que corre desde un temporizador y no
  // desde un render: con el estado a secas mandaría el borrador que existía
  // cuando se agendó, o sea el de antes de la última tecla del usuario.
  const draftRef = useRef<PreferencesDraft | null>(null);
  const baselineRef = useRef<PreferencesDraft | null>(null);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // La semilla se toma **una sola vez**. Después, lo que manda es el borrador:
  // volver a sembrar con cada respuesta pisaría lo que el usuario escribió
  // mientras había un guardado en vuelo.
  useEffect(() => {
    if (query.data === undefined) return;
    if (baselineRef.current !== null) return;
    const seeded = toDraft(query.data);
    baselineRef.current = seeded;
    setBaseline(seeded);
    setDraft(seeded);
  }, [query.data]);

  const save = useCallback(async (): Promise<SaveOutcome> => {
    const from = baselineRef.current;
    const to = draftRef.current;
    if (from === null || to === null) return "noop";

    const { patch } = buildPreferencesPatch(from, to);
    if (patch === null) return "noop";

    const saved = await mutation.mutateAsync(patch);
    const confirmed = toDraft(saved);
    baselineRef.current = confirmed;
    setBaseline(confirmed);
    // La caché se actualiza con la respuesta y no se invalida: invalidar
    // dispararía un `GET` que no aporta nada —el `PATCH` ya devuelve el recurso
    // completo— y gastaría el rate limit de §9.6 por cada cambio.
    queryClient.setQueryData<BlitzPreferences>(queryKeys.blitzPreferences(), saved);
    return "sent";
  }, [mutation, queryClient]);

  const autosave = useAutosave({ save });
  const { queue } = autosave;
  const genderId = useId();

  const update = useCallback(
    (mutate: (current: PreferencesDraft) => PreferencesDraft) => {
      setDraft((current) => (current === null ? current : mutate(current)));
      queue();
    },
    [queue],
  );

  if (query.isError) {
    return (
      <ApiErrorState
        error={query.error}
        onRetry={() => {
          void query.refetch();
        }}
      />
    );
  }

  if (query.isPending || draft === null || baseline === null) {
    return (
      <div className="fgw-prefs" aria-busy="true">
        <Skeleton shape="text" width="40%" />
        <Skeleton shape="text" width="70%" />
        <Skeleton shape="text" width="55%" />
      </div>
    );
  }

  const { blocked } = buildPreferencesPatch(baseline, draft);

  // El orden importa: un fallo tapa a un bloqueo, y un bloqueo tapa a
  // "guardado". Lo que no puede pasar es que `saved` gane a ninguno de los dos
  // — es la única frase de esta pantalla sobre la que alguien cierra la
  // pestaña.
  const bannerStatus: BannerStatus =
    autosave.status === "error"
      ? "error"
      : blocked.length > 0
        ? "blocked"
        : autosave.status;

  const firstBlocked = blocked[0];
  const mix = mixOf(draft);
  const styleOn = isStyleMixOn(draft.textStyleWeights);

  return (
    <div className="fgw-prefs">
      <SaveStatusBanner
        status={bannerStatus}
        error={autosave.error}
        blockedLabel={
          firstBlocked === undefined ? undefined : tw(BLOCKED_COPY[firstBlocked])
        }
        onRetry={autosave.retry}
      />

      <p className="fgw-prefs__note">
        {tw("prefs.application", {
          count: query.data.settingsApplication.targetQueuedItems,
        })}
      </p>

      <section className="fgw-prefs__section" aria-labelledby="prefs-mix">
        <h2 id="prefs-mix" className="fgw-prefs__heading">
          {tw("prefs.section.contentMix")}
        </h2>
        <p className="fgw-prefs__hint">{tw("prefs.section.contentMixHint")}</p>
        {MIX_KEYS.map((key) => (
          <WeightSlider
            key={key}
            label={tw(MIX_COPY[key])}
            value={draft[key]}
            onChange={(value) => {
              update((current) =>
                applyMix(current, setWeight(mixOf(current), key, value)),
              );
            }}
          />
        ))}
        <p className="fgw-prefs__sum" data-sum={sumWeights(mix)}>
          {tw("prefs.sum", { sum: sumWeights(mix) })}
        </p>
      </section>

      <section className="fgw-prefs__section" aria-labelledby="prefs-ratios">
        <h2 id="prefs-ratios" className="fgw-prefs__heading">
          {tw("prefs.section.ratios")}
        </h2>
        {RATIO_KEYS.map((key) => (
          <WeightSlider
            key={key}
            label={tw(RATIO_COPY[key])}
            value={draft[key]}
            hint={
              key === "influencerChance"
                ? tw("prefs.ratio.influencerChanceHint")
                : undefined
            }
            onChange={(value) => {
              update((current) => withRatio(current, key, value));
            }}
          />
        ))}

        {/* El nombre accesible del interruptor sale de `aria-label` y no de un
            `<label>` que lo envuelva: el control es un `<button>` y un label
            envolvente le sumaría el texto de la fila entera. */}
        <div className="fgw-prefs__row">
          <span className="fgw-prefs__label">{tw("prefs.smartText")}</span>
          <Switch
            checked={draft.smartTextPositioning}
            aria-label={tw("prefs.smartText")}
            onCheckedChange={(checked) => {
              update((current) => ({ ...current, smartTextPositioning: checked }));
            }}
          />
        </div>

        <div className="fgw-prefs__row">
          <label className="fgw-prefs__label" htmlFor={genderId}>
            {tw("prefs.gender.label")}
          </label>
          <Select
            id={genderId}
            value={draft.genderFilter ?? ""}
            options={GENDER_OPTIONS.map((value) => ({
              value,
              label: tw(GENDER_COPY[value] ?? "prefs.gender.any"),
            }))}
            onChange={(event) => {
              const next = event.target.value;
              update((current) => ({
                ...current,
                // `""` es el `null` de FR-055, que es un valor y no una
                // ausencia: sin él no habría forma de quitar el filtro.
                genderFilter: isGenderFilter(next) ? next : null,
              }));
            }}
          />
        </div>
      </section>

      <section className="fgw-prefs__section" aria-labelledby="prefs-captions">
        <h2 id="prefs-captions" className="fgw-prefs__heading">
          {tw("prefs.section.captions")}
        </h2>
        <p className="fgw-prefs__hint">{tw("prefs.section.captionsHint")}</p>

        <div className="fgw-prefs__row">
          <span className="fgw-prefs__label">{tw("prefs.styleMix.toggle")}</span>
          <Switch
            checked={styleOn}
            aria-label={tw("prefs.styleMix.toggle")}
            onCheckedChange={(checked) => {
              update((current) => ({
                ...current,
                // Apagado es `{}` y no un mapa en ceros: FR-055 (PRD:1277) dice
                // que el mapa vacío **desactiva** el mix, y un mapa de siete
                // ceros no suma 100, o sea `400` en cada guardado.
                textStyleWeights: checked ? evenWeights(TEXT_STYLE_PRESETS) : {},
              }));
            }}
          />
        </div>

        {styleOn ? (
          TEXT_STYLE_PRESETS.map((preset) => (
            <WeightSlider
              key={preset}
              label={tw(TEXT_STYLE_COPY[preset] ?? "prefs.styleMix.toggle")}
              value={draft.textStyleWeights[preset] ?? 0}
              onChange={(value) => {
                update((current) => ({
                  ...current,
                  textStyleWeights: setWeight(current.textStyleWeights, preset, value),
                }));
              }}
            />
          ))
        ) : (
          <p className="fgw-prefs__hint">{tw("prefs.styleMix.off")}</p>
        )}
      </section>

      <p className="fgw-prefs__gap">{tw("prefs.angleWeightsMissing")}</p>
    </div>
  );
}
