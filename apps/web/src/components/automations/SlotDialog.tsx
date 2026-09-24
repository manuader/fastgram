"use client";

import {
  Badge,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Select,
  Textarea,
  useToast,
} from "@fastgram/ui";
import type { Automation, AutomationSlot, BlitzContentType } from "@fastgram/contracts";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState } from "react";
import { editorHref } from "@/components/editor/ContentEditor";
import { copyKeyForError } from "@/lib/api/errors";
import { NETWORK_LABEL } from "@/lib/calendar/board";
import { tw } from "@/lib/i18n/t";
import {
  useRemoveSlot,
  useRerollSlot,
  useSlotContent,
  useUpdateSlot,
} from "@/lib/automations/api";
import {
  CONTENT_TYPE_COPY,
  SLOT_STATUS_COPY,
  SLOT_STATUS_TONE,
  fromLocalInput,
  generationBlockedCopy,
  slotFailureCopy,
  toLocalInput,
} from "@/lib/automations/present";
import { SlotPreview } from "./SlotViews";

/** Redes donde la caption tiene título + cuerpo (`FR-150`: YouTube; TikTok, `FR-060`). */
const WITH_DESCRIPTION: ReadonlySet<string> = new Set(["youtube", "tiktok"]);

export interface SlotDialogProps {
  readonly automation: Automation;
  readonly slot: AutomationSlot | null;
  readonly onClose: () => void;
}

/**
 * `Post details` — `F-214`, `F-215`. Un slot en revisión: `Edit post` (los
 * textos de la pieza), las captions por red (reemplazan el mapa entero),
 * `Adjust schedule`, `Re-roll this suggestion` (con tipo opcional; nunca uno
 * en 0 ni slideshow con YouTube), `Remove suggestion` → `Confirm remove`, y
 * abrir la pieza en el editor. Después del launch, sólo lectura con los posts.
 */
export function SlotDialog({ automation, slot, onClose }: SlotDialogProps) {
  return (
    <Dialog open={slot !== null} onClose={onClose} size="lg">
      {slot !== null && (
        <SlotDialogBody automation={automation} slot={slot} onClose={onClose} />
      )}
    </Dialog>
  );
}

function SlotDialogBody({
  automation,
  slot,
  onClose,
}: {
  readonly automation: Automation;
  readonly slot: AutomationSlot;
  readonly onClose: () => void;
}) {
  const reviewing = automation.status === "REVIEW";
  const editable = reviewing && slot.status === "READY";
  const [texts, setTexts] = useState<string[]>([...slot.texts]);
  const [captions, setCaptions] = useState(slot.captionsByPlatform);
  const [when, setWhen] = useState(
    slot.scheduledAt === null ? "" : toLocalInput(slot.scheduledAt, automation.timezone),
  );
  const [rerollType, setRerollType] = useState<BlitzContentType | "">("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const update = useUpdateSlot(automation.id);
  const reroll = useRerollSlot(automation.id);
  const remove = useRemoveSlot(automation.id);
  const content = useSlotContent(automation.id);
  const router = useRouter();
  const { toast } = useToast();
  const whenId = useId();

  useEffect(() => {
    setTexts([...slot.texts]);
    setCaptions(slot.captionsByPlatform);
  }, [slot]);

  const fail = (e: unknown) => {
    setError(generationBlockedCopy(e) ?? tw(copyKeyForError(e)));
  };

  const hasYouTube = automation.accounts.some((a) => a.platform === "youtube");
  const allowedTypes = (
    [
      ["slideshow", automation.prefsSnapshot.slideshowWeight],
      ["wall-of-text", automation.prefsSnapshot.wallOfTextWeight],
      ["green-screen", automation.prefsSnapshot.greenScreenWeight],
      ["video-hook", automation.prefsSnapshot.videoHookWeight],
    ] as const
  )
    .filter(([type, w]) => w > 0 && !(type === "slideshow" && hasYouTube))
    .map(([type]) => type);

  async function save() {
    setError(null);
    const scheduledAt = when === "" ? null : fromLocalInput(when, automation.timezone);
    const body = {
      ...(slot.contentId === null && texts.join("\u0000") !== slot.texts.join("\u0000")
        ? { texts }
        : {}),
      captionsByPlatform: Object.fromEntries(
        Object.entries(captions).map(([platform, c]) => [
          platform,
          c.description === undefined || !WITH_DESCRIPTION.has(platform)
            ? { caption: c.caption }
            : { caption: c.caption, description: c.description },
        ]),
      ),
      ...(scheduledAt !== null && scheduledAt !== slot.scheduledAt
        ? { scheduledAt }
        : {}),
    };
    try {
      await update.mutateAsync({ slotId: slot.id, body });
      toast({ title: tw("automations.toast.slotSaved"), tone: "success" });
      onClose();
    } catch (e: unknown) {
      fail(e);
    }
  }

  const failure = slotFailureCopy(slot);

  return (
    <>
      <DialogHeader>
        <DialogTitle>{tw("automations.slotDialog.title")}</DialogTitle>
      </DialogHeader>
      <DialogBody className="flex flex-col gap-4">
        <div className="flex flex-col gap-4 sm:flex-row">
          <SlotPreview slot={slot} className="aspect-[4/5] w-full rounded-lg sm:w-48" />
          <div className="flex flex-1 flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <Badge tone={SLOT_STATUS_TONE[slot.status]} dot>
                {tw(SLOT_STATUS_COPY[slot.status])}
              </Badge>
              <Badge tone="outline">{tw(CONTENT_TYPE_COPY[slot.contentType])}</Badge>
              {slot.topic !== null && <Badge tone="info">{slot.topic}</Badge>}
            </div>
            {failure !== null && <p className="text-sm text-danger">{tw(failure)}</p>}
            {slot.aiExplanation !== null && (
              <p className="text-xs text-text-muted">{slot.aiExplanation}</p>
            )}
          </div>
        </div>

        {slot.texts.length > 0 && (
          <section
            className="flex flex-col gap-2"
            aria-label={tw("automations.slotDialog.editPost")}
          >
            <h3 className="text-sm font-semibold text-text">
              {tw("automations.slotDialog.editPost")}
            </h3>
            {slot.contentId !== null && editable && (
              <p className="text-xs text-text-muted">
                {tw("automations.slotDialog.inEditor")}
              </p>
            )}
            {texts.map((t, i) => (
              <Textarea
                key={i}
                aria-label={tw("automations.slotDialog.text", { n: i + 1 })}
                value={t}
                disabled={!editable || slot.contentId !== null}
                onChange={(e) => {
                  const next = [...texts];
                  next[i] = e.target.value;
                  setTexts(next);
                }}
              />
            ))}
          </section>
        )}

        {Object.keys(captions).length > 0 && (
          <section
            className="flex flex-col gap-2"
            aria-label={tw("automations.slotDialog.captions")}
          >
            <h3 className="text-sm font-semibold text-text">
              {tw("automations.slotDialog.captions")}
            </h3>
            {Object.entries(captions).map(([platform, c]) => {
              const network =
                NETWORK_LABEL[platform as keyof typeof NETWORK_LABEL] ?? platform;
              return (
                <div
                  key={platform}
                  className="flex flex-col gap-1.5 rounded-lg border border-border p-3"
                >
                  <span className="text-xs font-medium text-text-muted">{network}</span>
                  <Input
                    aria-label={tw("automations.slotDialog.caption", { network })}
                    value={c.caption}
                    disabled={!editable}
                    onChange={(e) => {
                      setCaptions({
                        ...captions,
                        [platform]: { ...c, caption: e.target.value },
                      });
                    }}
                  />
                  {WITH_DESCRIPTION.has(platform) && (
                    <Textarea
                      aria-label={tw("automations.slotDialog.description", { network })}
                      value={c.description ?? ""}
                      disabled={!editable}
                      onChange={(e) => {
                        setCaptions({
                          ...captions,
                          [platform]: { ...c, description: e.target.value },
                        });
                      }}
                    />
                  )}
                </div>
              );
            })}
          </section>
        )}

        {editable && (
          <div className="flex flex-col gap-1.5">
            <label htmlFor={whenId} className="text-sm font-semibold text-text">
              {tw("automations.slotDialog.adjustSchedule")}
            </label>
            <Input
              id={whenId}
              type="datetime-local"
              value={when}
              onChange={(e) => {
                setWhen(e.target.value);
              }}
            />
            <span className="text-xs text-text-muted">
              {tw("automations.slotDialog.timezone", { tz: automation.timezone })}
            </span>
          </div>
        )}

        {slot.posts.length > 0 && (
          <section
            className="flex flex-col gap-2"
            aria-label={tw("automations.slotDialog.posts")}
          >
            <h3 className="text-sm font-semibold text-text">
              {tw("automations.slotDialog.posts")}
            </h3>
            <ul className="flex flex-col gap-1 text-sm">
              {slot.posts.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {NETWORK_LABEL[p.platform as keyof typeof NETWORK_LABEL] ??
                      p.platform}
                  </span>
                  <Badge size="sm" tone="outline">
                    {p.status}
                  </Badge>
                  {p.postUrl !== null && (
                    <a
                      className="text-accent underline"
                      href={p.postUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {tw("automations.slotDialog.openPost")}
                    </a>
                  )}
                  <span className="text-xs text-text-muted">
                    {tw("automations.slotDialog.metrics", {
                      views: p.views,
                      likes: p.likes,
                      comments: p.comments,
                    })}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {reviewing && (slot.status === "READY" || slot.status === "FAILED_GEN") && (
          <section className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
            <Select
              aria-label={tw("automations.slotDialog.rerollType")}
              value={rerollType}
              onChange={(e) => {
                setRerollType(e.target.value as BlitzContentType | "");
              }}
              options={[
                { value: "", label: tw("automations.slotDialog.sameType") },
                ...allowedTypes.map((t) => ({
                  value: t,
                  label: tw(CONTENT_TYPE_COPY[t]),
                })),
              ]}
            />
            <Button
              variant="secondary"
              loading={reroll.isPending}
              onClick={() => {
                setError(null);
                reroll
                  .mutateAsync({
                    slotId: slot.id,
                    contentType: rerollType === "" ? null : rerollType,
                  })
                  .then(() => {
                    toast({ title: tw("automations.toast.rerolling"), tone: "success" });
                    onClose();
                  })
                  .catch(fail);
              }}
            >
              {tw("automations.slotDialog.reroll")}
            </Button>
            {confirmRemove ? (
              <Button
                variant="danger"
                loading={remove.isPending}
                onClick={() => {
                  remove
                    .mutateAsync(slot.id)
                    .then(() => {
                      onClose();
                    })
                    .catch(fail);
                }}
              >
                {tw("automations.slotDialog.confirmRemove")}
              </Button>
            ) : (
              <Button
                variant="ghost"
                onClick={() => {
                  setConfirmRemove(true);
                }}
              >
                {tw("automations.slotDialog.remove")}
              </Button>
            )}
          </section>
        )}
        {reviewing && slot.status === "READY" && (
          <p className="text-xs text-text-muted">
            {tw("automations.slotDialog.rerollHint")}
          </p>
        )}

        {error !== null && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
      </DialogBody>
      <DialogFooter>
        {editable && (
          <Button
            variant="ghost"
            loading={content.isPending}
            onClick={() => {
              content
                .mutateAsync(slot.id)
                .then((contentId) => {
                  router.push(editorHref(contentId));
                })
                .catch(fail);
            }}
          >
            {tw("automations.slotDialog.openEditor")}
          </Button>
        )}
        {!editable && slot.contentId !== null && (
          <Button
            variant="ghost"
            onClick={() => {
              router.push(editorHref(slot.contentId ?? ""));
            }}
          >
            {tw("automations.slotDialog.openEditor")}
          </Button>
        )}
        <Button variant="secondary" onClick={onClose}>
          {tw("common.close")}
        </Button>
        {editable && (
          <Button
            loading={update.isPending}
            onClick={() => {
              void save();
            }}
          >
            {tw("automations.slotDialog.save")}
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
