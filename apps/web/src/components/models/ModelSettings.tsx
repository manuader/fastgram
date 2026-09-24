"use client";

import {
  CHARACTER_MODEL_NOTES_MAX,
  CHARACTER_MODEL_STYLE_MAX,
  CHARACTER_VOICE_MODELS,
  INFLUENCER_AGE_MAX,
  INFLUENCER_AGE_MIN,
  type CharacterModel,
  type UpdateCharacterModelRequest,
} from "@fastgram/contracts";
import { Button, Checkbox, Input, Select, Textarea } from "@fastgram/ui";
import { useId, useState } from "react";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";
import { tw } from "@/lib/i18n/t";
import { useSetModelBrands, useUpdateModel } from "./api";

/** Lo que cambió del formulario de detalles, o `null` si nada o algo es inválido. */
export function detailsPatch(
  model: Pick<CharacterModel, "name" | "age" | "style" | "notes">,
  form: {
    readonly name: string;
    readonly age: string;
    readonly style: string;
    readonly notes: string;
  },
): UpdateCharacterModelRequest | null {
  const name = form.name.trim();
  if (name === "") return null;
  const ageRaw = form.age.trim();
  const age = ageRaw === "" ? null : Number(ageRaw);
  if (
    age !== null &&
    (!Number.isInteger(age) || age < INFLUENCER_AGE_MIN || age > INFLUENCER_AGE_MAX)
  )
    return null;
  const style = form.style.trim() === "" ? null : form.style.trim();
  const notes = form.notes.trim() === "" ? null : form.notes.trim();
  const patch: UpdateCharacterModelRequest = {
    ...(name === model.name ? {} : { name }),
    ...(age === model.age ? {} : { age }),
    ...(style === model.style ? {} : { style }),
    ...(notes === model.notes ? {} : { notes }),
  };
  return Object.keys(patch).length === 0 ? null : patch;
}

export function DetailsSection({ model }: { readonly model: CharacterModel }) {
  const ids = { name: useId(), age: useId(), style: useId(), notes: useId() };
  const [form, setForm] = useState({
    name: model.name,
    age: model.age === null ? "" : String(model.age),
    style: model.style ?? "",
    notes: model.notes ?? "",
  });
  const update = useUpdateModel(model.id);
  const patch = detailsPatch(model, form);
  const set = (k: keyof typeof form) => (value: string) => {
    setForm((f) => ({ ...f, [k]: value }));
  };
  return (
    <section className="flex flex-col gap-3" aria-labelledby={`${ids.name}-h`}>
      <h2 id={`${ids.name}-h`} className="m-0 text-lg font-semibold text-text">
        {tw("charModels.details.title")}
      </h2>
      <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.name} className="text-sm font-medium text-text">
            {tw("charModels.import.name")}
          </label>
          <Input
            id={ids.name}
            value={form.name}
            maxLength={100}
            onChange={(e) => {
              set("name")(e.target.value);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.age} className="text-sm font-medium text-text">
            {tw("charModels.details.age")}
          </label>
          <Input
            id={ids.age}
            inputMode="numeric"
            value={form.age}
            onChange={(e) => {
              set("age")(e.target.value);
            }}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.style} className="text-sm font-medium text-text">
          {tw("charModels.details.style")}
        </label>
        <Input
          id={ids.style}
          value={form.style}
          maxLength={CHARACTER_MODEL_STYLE_MAX}
          placeholder={tw("charModels.details.stylePlaceholder")}
          onChange={(e) => {
            set("style")(e.target.value);
          }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={ids.notes} className="text-sm font-medium text-text">
          {tw("charModels.details.notes")}
        </label>
        <Textarea
          id={ids.notes}
          rows={3}
          maxLength={CHARACTER_MODEL_NOTES_MAX}
          value={form.notes}
          placeholder={tw("charModels.details.notesPlaceholder")}
          onChange={(e) => {
            set("notes")(e.target.value);
          }}
        />
        <p className="m-0 text-xs text-text-subtle">
          {tw("charModels.details.notesHint")}
        </p>
      </div>
      {update.isError && (
        <p className="m-0 text-sm text-danger" role="alert">
          {update.error.serverMessage ?? tw("charModels.saveFailed")}
        </p>
      )}
      <div>
        <Button
          size="sm"
          loading={update.isPending}
          disabled={patch === null}
          onClick={() => {
            if (patch !== null) update.mutate(patch);
          }}
        >
          {tw("charModels.save")}
        </Button>
      </div>
    </section>
  );
}

/**
 * Voz del modelo: proveedor fal, un modelo TTS del catálogo del contrato y la
 * voz. fal no tiene endpoint de listado de voces: el campo es libre y ofrece
 * las del esquema del modelo como sugerencias (`<datalist>`).
 */
export function VoiceSection({ model }: { readonly model: CharacterModel }) {
  const ids = { model: useId(), voice: useId(), list: useId() };
  const [tts, setTts] = useState<string>(
    model.voice?.model ?? CHARACTER_VOICE_MODELS[0].model,
  );
  const catalog = CHARACTER_VOICE_MODELS.find((m) => m.model === tts);
  const [voiceId, setVoiceId] = useState(
    model.voice?.voiceId ?? catalog?.defaultVoice ?? "",
  );
  const update = useUpdateModel(model.id);
  const trimmed = voiceId.trim();
  const unchanged = model.voice?.model === tts && model.voice.voiceId === trimmed;

  return (
    <section className="flex flex-col gap-3" aria-labelledby={`${ids.model}-h`}>
      <h2 id={`${ids.model}-h`} className="m-0 text-lg font-semibold text-text">
        {tw("charModels.voice.title")}
      </h2>
      <p className="m-0 text-sm text-text-muted">{tw("charModels.voice.body")}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.model} className="text-sm font-medium text-text">
            {tw("charModels.voice.model")}
          </label>
          <Select
            id={ids.model}
            value={tts}
            options={CHARACTER_VOICE_MODELS.map((m) => ({
              value: m.model,
              label: m.label,
            }))}
            onChange={(e) => {
              const next = CHARACTER_VOICE_MODELS.find((m) => m.model === e.target.value);
              setTts(e.target.value);
              if (next !== undefined) setVoiceId(next.defaultVoice);
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={ids.voice} className="text-sm font-medium text-text">
            {tw("charModels.voice.voice")}
          </label>
          <Input
            id={ids.voice}
            list={ids.list}
            value={voiceId}
            maxLength={100}
            onChange={(e) => {
              setVoiceId(e.target.value);
            }}
          />
          <datalist id={ids.list}>
            {catalog?.voices.map((v) => (
              <option key={v} value={v} />
            ))}
          </datalist>
        </div>
      </div>
      <p className="m-0 text-xs text-text-subtle">{tw("charModels.voice.hint")}</p>
      {update.isError && (
        <p className="m-0 text-sm text-danger" role="alert">
          {update.error.serverMessage ?? tw("charModels.saveFailed")}
        </p>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          loading={update.isPending}
          disabled={trimmed === "" || unchanged}
          onClick={() => {
            update.mutate({ voice: { provider: "fal", model: tts, voiceId: trimmed } });
          }}
        >
          {tw("charModels.voice.save")}
        </Button>
        {model.voice !== null && (
          <Button
            size="sm"
            variant="ghost"
            disabled={update.isPending}
            onClick={() => {
              update.mutate({ voice: null });
            }}
          >
            {tw("charModels.voice.remove")}
          </Button>
        )}
      </div>
    </section>
  );
}

/** Asignar el modelo a una o más marcas del dueño. Sólo con el modelo listo. */
export function BrandsSection({ model }: { readonly model: CharacterModel }) {
  const headingId = useId();
  const { workspaces } = useWorkspace();
  const [selected, setSelected] = useState<string[]>([...model.brandIds]);
  const save = useSetModelBrands(model.id);
  const brands = workspaces.data ?? [];
  const same =
    selected.length === model.brandIds.length &&
    selected.every((id) => model.brandIds.includes(id));
  const ready = model.status === "ready";

  return (
    <section className="flex flex-col gap-3" aria-labelledby={headingId}>
      <h2 id={headingId} className="m-0 text-lg font-semibold text-text">
        {tw("charModels.brands.title")}
      </h2>
      <p className="m-0 text-sm text-text-muted">{tw("charModels.brands.body")}</p>
      {!ready && (
        <p className="m-0 text-sm text-warning">{tw("charModels.brands.notReady")}</p>
      )}
      {workspaces.isPending ? (
        <p className="m-0 text-sm text-text-muted">{tw("charModels.loading")}</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {brands.map((b) => (
            <li key={b.id}>
              <Checkbox
                label={b.name}
                checked={selected.includes(b.id)}
                disabled={!ready || save.isPending}
                onChange={(e) => {
                  const on = e.target.checked;
                  setSelected((s) => (on ? [...s, b.id] : s.filter((x) => x !== b.id)));
                }}
              />
            </li>
          ))}
        </ul>
      )}
      {save.isError && (
        <p className="m-0 text-sm text-danger" role="alert">
          {save.error.serverMessage ?? tw("charModels.saveFailed")}
        </p>
      )}
      <div>
        <Button
          size="sm"
          loading={save.isPending}
          disabled={!ready || same}
          onClick={() => {
            save.mutate(selected);
          }}
        >
          {tw("charModels.brands.save")}
        </Button>
      </div>
    </section>
  );
}
