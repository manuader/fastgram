/**
 * Copy del deck de Blitz · FR-050 (PRD:1105-1180), `PU-BLITZ-001/002`.
 *
 * ## Por qué un catálogo local y no `lib/i18n/messages.ts`
 *
 * Este sprint corre con varios agentes en paralelo y `lib/i18n/**` no es de este
 * módulo. El catálogo vive acá con la **misma forma** que `webEn` —clave →
 * plantilla, con `{huecos}` que resuelve `interpolate` de `@fastgram/ui`— para
 * que mudarlo a `messages.ts` sea cortar y pegar y cambiar `td` por `tw`.
 *
 * Convención de los comentarios, la de `messages.ts`: `literal` = texto del
 * PRD tal cual; `nuevo` = el PRD no lo da y lo escribió esta tarea.
 */
import { interpolate, type MessageVars } from "@fastgram/ui";

export const deckEn = {
  "deck.title": "Blitz", // literal
  "deck.configure": "Configure", // literal FR-050 · `⚙ Configure`
  "deck.skip": "Skip", // nuevo · el PRD sólo dibuja `✕`
  "deck.accept": "Accept", // nuevo · el PRD sólo dibuja `✓`
  "deck.edit": "Edit", // literal
  "deck.comingSoon": "Coming soon", // nuevo
  "deck.accept.scheduleAuto": "Add it to the next free slot of this brand's strategy", // nuevo
  "deck.viewCalendar": "View calendar", // nuevo
  "deck.scheduleFailed":
    "Saved to Library, but it couldn't be scheduled. Try again from the calendar.", // nuevo
  "deck.keyHint": "Use ← to skip and → to accept", // nuevo
  "deck.indicator.accept": "Accept", // nuevo
  "deck.indicator.skip": "Skip", // nuevo
  "deck.cardLabel": "{type} suggestion", // nuevo · nombre accesible de la tarjeta
  "deck.cardHelp": "Drag right or press → to accept. Drag left or press ← to skip.", // nuevo
  "deck.why": "Why This Content?", // literal
  "deck.why.title": "Why This Content", // literal
  "deck.why.empty": "No explanation was stored with this suggestion.", // nuevo
  "deck.remixedFrom": "Remixed From", // literal
  "deck.remix.open": "Open original", // nuevo
  "deck.remix.likes": "{count} likes", // nuevo · el PRD sólo muestra el icono
  "deck.remix.views": "{count} views", // nuevo · ídem
  "deck.mute": "Mute", // literal
  "deck.unmute": "Unmute", // literal
  "deck.reel.play": "Play reel", // nuevo · sprint 9
  "deck.reel.pause": "Pause reel", // nuevo · sprint 9
  "deck.reel.poster": "Reel · renders when you accept", // nuevo · sprint 9 (U)
  "deck.reel.posterDuration": "Reel · {seconds}s · renders when you accept", // nuevo · sprint 9 (U)
  "deck.slide.prev": "Previous slide", // nuevo
  "deck.slide.next": "Next slide", // nuevo
  "deck.slide.position": "Slide {current} of {total}", // nuevo
  "deck.influencer": "👤 {name}", // literal (forma) F-054
  "deck.tags": "Content tags", // nuevo · nombre accesible de la fila de chips
  "deck.remaining": "{count} in queue", // nuevo
  "deck.remainingOne": "1 in queue", // nuevo

  "deck.accept.title": "What would you like to do?", // literal M-04
  "deck.accept.step": "Step 1 of 3", // literal M-04
  "deck.accept.save": "Save to Library", // literal
  "deck.accept.saveDescription": "Save this content for later", // literal
  "deck.accept.schedule": "Schedule Post", // literal
  "deck.accept.scheduleDescription": "Post or schedule to your platforms", // literal
  "deck.accept.cancel": "Cancel", // literal
  "deck.accept.saving": "Saving…", // nuevo

  "deck.builds.title": "Recent builds", // nuevo
  "deck.builds.building": "Building…", // nuevo · mismo texto que la Library
  "deck.builds.ready": "Ready", // nuevo
  "deck.builds.failed": "Build failed", // nuevo
  "deck.builds.open": "Open", // nuevo
  "deck.builds.viewInLibrary": "View in Library", // literal (toast §3.5)
  "deck.builds.hint": "Builds take about 30 s to 2 min. You can keep swiping meanwhile.", // nuevo · FR-050 `processing`

  "deck.empty.title": "Your queue is being generated", // nuevo
  "deck.empty.description":
    "The discovery queue has no ready items yet. New suggestions show up here on their own — no need to reload.", // paráfrasis ERR-E11
  "deck.empty.llmHint":
    "Still empty after a few minutes? Blitz needs an AI model to generate suggestions.", // nuevo
  "deck.empty.llmLink": "Check AI models", // nuevo
  "deck.refilling": "Loading more suggestions…", // nuevo

  "deck.profile.title": "Your brand profile isn't ready yet", // nuevo · ERR-P08 da sólo el código
  "deck.profile.description":
    "Blitz builds everything on top of your brand profile. Finish it and suggestions start arriving.", // nuevo

  "deck.unbuildable":
    "That suggestion can't be built anymore, so it was skipped and nothing was charged.", // paráfrasis del 422 de la API
  "deck.skipFailed": "Couldn't skip that suggestion. It's back in the deck.", // nuevo
  "deck.fromPrompt": "From your prompt", // nuevo · PU-BLITZ-003, chip de la tarjeta
  "deck.autoFoundMeme": "Auto-found meme", // nuevo · sprint 7, chip de la tarjeta
  "deck.autoFoundMemeSource": "Where this meme came from", // nuevo · sprint 7, link del chip

  // Create from prompt · PU-BLITZ-003 (EXT-009). Todo `nuevo`: el PRD no lo dibuja.
  "prompt.title": "Create from prompt", // nuevo
  "prompt.label": "What should it be about?", // nuevo
  "prompt.placeholder": "e.g. a meme about Mondays for my coffee shop", // nuevo
  "prompt.format": "Format", // nuevo
  "prompt.format.any": "Any format (your mix)", // nuevo
  "prompt.count": "How many", // nuevo
  "prompt.submit": "Create", // nuevo
  "prompt.tooShort": "Write at least 3 characters.", // nuevo
  "prompt.tooLong": "Keep it under 500 characters.", // nuevo
  "prompt.generating": "Creating {count} pieces from your prompt…", // nuevo
  "prompt.generatingOne": "Creating a piece from your prompt…", // nuevo
  "prompt.queued": "Waiting for the generator to pick it up…", // nuevo
  "prompt.done": "{count} new pieces are at the top of your deck.", // nuevo
  "prompt.doneOne": "Your new piece is at the top of your deck.", // nuevo
  "prompt.donePartial":
    "{count} of {requested} pieces made it — the model's copy for the rest didn't pass our checks.", // nuevo
  "prompt.submitFailed": "Couldn't start that. Try again.", // nuevo
  "prompt.statusFailed": "Lost track of that request. It may still show up in your deck.", // nuevo
  "prompt.dismiss": "Dismiss", // nuevo
  "prompt.failed.llm":
    "There's no AI model set up for text, so nothing could be written.", // nuevo
  "prompt.failed.llmLink": "Set up AI models", // nuevo
  "prompt.failed.llmFailed":
    "The AI model didn't respond after a few tries. Check it's running, then try again.", // nuevo
  "prompt.failed.noMediaForFormat":
    "Your Library has no media for that format yet. Upload some and tag it for that format.", // nuevo
  "prompt.failed.noMedia":
    "None of the formats in your mix has media in your Library yet.", // nuevo
  "prompt.failed.mediaLink": "Go to Library", // nuevo
  "prompt.failed.copyRejected":
    "The AI's text didn't pass our checks. Try rewording your prompt.", // nuevo
  "prompt.failed.generic": "Couldn't create pieces from that prompt.", // nuevo
  // Sprint 7 · memes desde un prompt. Todo `nuevo`.
  "prompt.searchingMeme":
    "Searching for a meme… Your Library had none for this topic, so we're finding one. This can take a minute.", // nuevo
  "prompt.failed.memeNotFound":
    "Couldn't find a green-screen meme for that topic. Import a clip from a link and try again.", // nuevo
  "prompt.failed.importLink": "Import a clip from a link", // nuevo
} as const;

export type DeckMessageKey = keyof typeof deckEn;

/** Traduce una clave del catálogo del deck. */
export function td(key: DeckMessageKey, vars?: MessageVars): string {
  return interpolate(deckEn[key], vars);
}
