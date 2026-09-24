"use client";

import {
  INFLUENCER_REFERENCES_MAX,
  INFLUENCER_REFERENCES_MIN,
  type CharacterModel,
  type CharacterModelSetup,
  type CreateCharacterModelRequest,
} from "@fastgram/contracts";
import {
  Button,
  Dialog,
  DialogBody,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@fastgram/ui";
import { useId, useRef, useState } from "react";
import { useWorkspace } from "@/components/brands/WorkspaceProvider";
import { newIdempotencyKey } from "@/lib/api/idempotency-key";
import { tw } from "@/lib/i18n/t";
import { useInfluencers } from "@/lib/influencers/api";
import { useImportModel } from "./api";
import { BrandImagePicker } from "./BrandImagePicker";

type Source = CreateCharacterModelRequest["source"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** El cuerpo del pedido, o `null` si falta algo. Pura: la prueba la ejercita. */
export function importRequest(
  source: Source,
  form: {
    readonly name: string;
    readonly brandId: string | null;
    readonly photos: readonly string[];
    readonly soulId: string;
    readonly portrait: string | null;
    readonly influencerId: string | null;
  },
): CreateCharacterModelRequest | null {
  const name = form.name.trim();
  if (form.brandId === null) return null;
  if (source === "photos") {
    if (name === "") return null;
    if (
      form.photos.length < INFLUENCER_REFERENCES_MIN ||
      form.photos.length > INFLUENCER_REFERENCES_MAX
    )
      return null;
    return {
      source,
      name,
      fromBrandId: form.brandId,
      referenceMediaIds: [...form.photos],
    };
  }
  if (source === "soul_id") {
    const soulId = form.soulId.trim();
    if (name === "" || !UUID_RE.test(soulId) || form.portrait === null) return null;
    return {
      source,
      name,
      fromBrandId: form.brandId,
      soulId,
      portraitMediaId: form.portrait,
    };
  }
  if (form.influencerId === null) return null;
  return {
    source,
    fromBrandId: form.brandId,
    influencerId: form.influencerId,
    ...(name === "" ? {} : { name }),
  };
}

export interface ImportModelDialogProps {
  readonly open: boolean;
  readonly setup: CharacterModelSetup;
  readonly onClose: () => void;
  readonly onImported: (model: CharacterModel) => void;
}

/**
 * Importar un modelo a la biblioteca, de tres formas: fotos (entrena un Soul
 * ID nuevo), un Soul ID que ya existe en Higgsfield, o un influencer listo de
 * la marca activa. Las fotos salen del Media Bank de la marca activa y se
 * copian a la biblioteca.
 */
export function ImportModelDialog({
  open,
  setup,
  onClose,
  onImported,
}: ImportModelDialogProps) {
  const ids = { name: useId(), soul: useId(), influencer: useId() };
  const { active } = useWorkspace();
  const brandId = active?.id ?? null;
  const [source, setSource] = useState<Source>("photos");
  const [name, setName] = useState("");
  const [photos, setPhotos] = useState<string[]>([]);
  const [soulId, setSoulId] = useState("");
  const [portrait, setPortrait] = useState<string[]>([]);
  const [influencerId, setInfluencerId] = useState("");
  const influencers = useInfluencers();
  const promotable = (influencers.data ?? []).filter(
    (i) => i.status === "ready" && i.modelId === undefined,
  );
  const create = useImportModel();
  // Una key por intento de importar: un doble click no crea dos modelos.
  const key = useRef(newIdempotencyKey());

  const body = importRequest(source, {
    name,
    brandId,
    photos,
    soulId,
    portrait: portrait[0] ?? null,
    influencerId: influencerId === "" ? null : influencerId,
  });
  const blockedByTraining = source === "photos" && !setup.canTrain;

  const close = () => {
    setName("");
    setPhotos([]);
    setSoulId("");
    setPortrait([]);
    setInfluencerId("");
    create.reset();
    key.current = newIdempotencyKey();
    onClose();
  };

  return (
    <Dialog open={open} onClose={close} size="lg">
      <DialogHeader>
        <DialogTitle>{tw("charModels.import.title")}</DialogTitle>
        <DialogClose label={tw("charModels.cancel")} />
      </DialogHeader>
      <DialogBody>
        <div className="flex flex-col gap-4">
          <p className="m-0 text-sm text-text-muted">
            {tw("charModels.import.fromBrand", { brand: active?.name ?? "—" })}
          </p>
          <div className="flex flex-col gap-2">
            <label htmlFor={ids.name} className="text-sm font-medium text-text">
              {source === "influencer"
                ? tw("charModels.import.nameOptional")
                : tw("charModels.import.name")}
            </label>
            <Input
              id={ids.name}
              value={name}
              maxLength={100}
              onChange={(e) => {
                setName(e.target.value);
              }}
            />
          </div>
          <Tabs
            defaultValue="photos"
            value={source}
            onValueChange={(v) => {
              setSource(v as Source);
              create.reset();
            }}
          >
            <TabsList aria-label={tw("charModels.import.title")}>
              <TabsTrigger value="photos">
                {tw("charModels.import.tab.photos")}
              </TabsTrigger>
              <TabsTrigger value="soul_id">
                {tw("charModels.import.tab.soul")}
              </TabsTrigger>
              <TabsTrigger value="influencer">
                {tw("charModels.import.tab.influencer")}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="photos">
              <div className="flex flex-col gap-3 pt-3">
                <p className="m-0 text-sm text-text-muted">
                  {tw("charModels.import.photos.hint", {
                    min: INFLUENCER_REFERENCES_MIN,
                    max: INFLUENCER_REFERENCES_MAX,
                  })}
                </p>
                {!setup.configured ? (
                  <p className="m-0 text-sm text-warning">
                    {tw("charModels.setup.body")}
                  </p>
                ) : !setup.canTrain ? (
                  <p className="m-0 text-sm text-warning">
                    {tw("charModels.import.photos.budget")}
                  </p>
                ) : null}
                <BrandImagePicker
                  brandId={brandId}
                  selected={photos}
                  onChange={setPhotos}
                  max={INFLUENCER_REFERENCES_MAX}
                  label={tw("charModels.import.photos.label")}
                />
              </div>
            </TabsContent>
            <TabsContent value="soul_id">
              <div className="flex flex-col gap-3 pt-3">
                <div className="flex flex-col gap-2">
                  <label htmlFor={ids.soul} className="text-sm font-medium text-text">
                    {tw("charModels.import.soul.label")}
                  </label>
                  <Input
                    id={ids.soul}
                    value={soulId}
                    placeholder="3eb3ad49-775d-40bd-b5e5-38b105108780"
                    onChange={(e) => {
                      setSoulId(e.target.value);
                    }}
                  />
                  <p className="m-0 text-xs text-text-subtle">
                    {tw("charModels.import.soul.hint")}
                  </p>
                </div>
                <BrandImagePicker
                  brandId={brandId}
                  selected={portrait}
                  onChange={setPortrait}
                  max={1}
                  label={tw("charModels.import.soul.portrait")}
                />
              </div>
            </TabsContent>
            <TabsContent value="influencer">
              <div className="flex flex-col gap-2 pt-3">
                <label htmlFor={ids.influencer} className="text-sm font-medium text-text">
                  {tw("charModels.import.influencer.label")}
                </label>
                {influencers.isPending ? (
                  <p className="m-0 text-sm text-text-muted">
                    {tw("charModels.loading")}
                  </p>
                ) : promotable.length === 0 ? (
                  <p className="m-0 text-sm text-text-muted">
                    {tw("charModels.import.influencer.empty")}
                  </p>
                ) : (
                  <Select
                    id={ids.influencer}
                    value={influencerId}
                    placeholder={tw("charModels.import.influencer.placeholder")}
                    options={promotable.map((i) => ({ value: i._id, label: i.name }))}
                    onChange={(e) => {
                      setInfluencerId(e.target.value);
                    }}
                  />
                )}
                <p className="m-0 text-xs text-text-subtle">
                  {tw("charModels.import.influencer.hint")}
                </p>
              </div>
            </TabsContent>
          </Tabs>
          {create.isError && (
            <p className="m-0 text-sm text-danger" role="alert">
              {create.error.serverMessage ?? tw("charModels.import.failed")}
            </p>
          )}
        </div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" onClick={close}>
          {tw("charModels.cancel")}
        </Button>
        <Button
          loading={create.isPending}
          disabled={body === null || blockedByTraining || create.isPending}
          onClick={() => {
            if (body === null) return;
            create.mutate(
              { body, idempotencyKey: key.current },
              {
                onSuccess: (model) => {
                  close();
                  onImported(model);
                },
              },
            );
          }}
        >
          {source === "photos"
            ? tw("charModels.import.submitTrain")
            : tw("charModels.import.submit")}
        </Button>
      </DialogFooter>
    </Dialog>
  );
}
