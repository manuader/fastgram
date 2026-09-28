/**
 * Las frases de «What Blitz learned», armadas **por código** desde los rasgos
 * — sprint 9 (Q), `D-22`. Nada de un LLM: cada frase es una plantilla del
 * catálogo i18n con el rasgo y su evidencia, así lo que se lee es exactamente
 * lo que el modelo aprendió.
 *
 * Un valor que no está en las tablas de abajo (una versión nueva del
 * vocabulario que la web todavía no conoce) cae en `null` y la fila no se
 * muestra: mejor callar que decir algo que no es.
 */
import type { LearnedPreference } from "@fastgram/contracts";
import { tw, type CopyKey } from "@/lib/i18n/t";
import { TEXT_STYLE_COPY } from "@/lib/blitz/preferences";

type Table = Readonly<Record<string, CopyKey>>;

const FORMAT: Table = {
  slideshow: "learned.thing.format.slideshow",
  "wall-of-text": "learned.thing.format.wallOfText",
  "green-screen": "learned.thing.format.greenScreen",
  "video-hook": "learned.thing.format.videoHook",
  custom: "learned.thing.format.custom",
};

const KIND: Table = {
  reaction: "learned.kind.reaction",
  laugh: "learned.kind.laugh",
  shock: "learned.kind.shock",
  facepalm: "learned.kind.facepalm",
  cringe: "learned.kind.cringe",
  celebrate: "learned.kind.celebrate",
  sad: "learned.kind.sad",
  angry: "learned.kind.angry",
  confused: "learned.kind.confused",
  smug: "learned.kind.smug",
  dance: "learned.kind.dance",
  animal: "learned.kind.animal",
  sports: "learned.kind.sports",
  movie: "learned.kind.movie",
  cartoon: "learned.kind.cartoon",
};

/** Familias cuyo valor es cerrado y tiene su propia frase. */
const CLOSED: Readonly<Record<string, Table>> = {
  format: FORMAT,
  "bg.tone": {
    dark: "learned.thing.bgTone.dark",
    light: "learned.thing.bgTone.light",
  },
  "bg.type": {
    image: "learned.thing.bgType.image",
    video: "learned.thing.bgType.video",
  },
  "bg.source": {
    upload: "learned.thing.bgSource.upload",
    generated: "learned.thing.bgSource.generated",
    brand: "learned.thing.bgSource.brand",
    library: "learned.thing.bgSource.library",
    imported: "learned.thing.bgSource.imported",
  },
  "clip.type": {
    image: "learned.thing.clipType.image",
    video: "learned.thing.clipType.video",
  },
  "clip.source": {
    upload: "learned.thing.clipSource.upload",
    generated: "learned.thing.clipSource.generated",
    brand: "learned.thing.clipSource.brand",
    library: "learned.thing.clipSource.library",
    imported: "learned.thing.clipSource.imported",
  },
  music: {
    none: "learned.thing.music.none",
    track: "learned.thing.music.track",
  },
  "music.source": {
    upload: "learned.thing.musicSource.upload",
    import: "learned.thing.musicSource.import",
    extracted: "learned.thing.musicSource.extracted",
    library: "learned.thing.musicSource.library",
  },
  "text.size": {
    small: "learned.thing.textSize.small",
    medium: "learned.thing.textSize.medium",
    large: "learned.thing.textSize.large",
  },
  "text.box": {
    yes: "learned.thing.textBox.yes",
    no: "learned.thing.textBox.no",
  },
  "text.len": {
    short: "learned.thing.textLen.short",
    medium: "learned.thing.textLen.medium",
    long: "learned.thing.textLen.long",
  },
  duration: {
    short: "learned.thing.duration.short",
    medium: "learned.thing.duration.medium",
    long: "learned.thing.duration.long",
  },
  origin: {
    refill: "learned.thing.origin.refill",
    prompt: "learned.thing.origin.prompt",
    remix: "learned.thing.origin.remix",
  },
};

const capitalize = (v: string): string =>
  v.length === 0 ? v : `${v.charAt(0).toUpperCase()}${v.slice(1)}`;

/** De qué habla el rasgo, como sustantivo: «dark backgrounds», «reaction memes». */
export function thingOf(item: LearnedPreference): string | null {
  const table = CLOSED[item.family];
  if (table !== undefined) {
    const key = table[item.value];
    return key === undefined ? null : tw(key);
  }
  switch (item.family) {
    case "clip.kind": {
      const kind = KIND[item.value];
      return kind === undefined ? null : tw("learned.thing.clipKind", { kind: tw(kind) });
    }
    case "text.preset": {
      const preset = TEXT_STYLE_COPY[item.value];
      return preset === undefined
        ? null
        : tw("learned.thing.textPreset", { label: tw(preset) });
    }
    case "text.font":
      return tw("learned.thing.textFont", { label: capitalize(item.value) });
    case "text.anim":
      return item.value === "none"
        ? tw("learned.thing.textAnimNone")
        : tw("learned.thing.textAnim", { label: item.value });
    case "angle":
      return item.label === null
        ? tw("learned.thing.angleUnknown")
        : tw("learned.thing.angle", { label: item.label });
    case "influencer":
      if (item.value === "none") return tw("learned.thing.influencerNone");
      return item.label === null
        ? tw("learned.thing.influencerUnknown")
        : tw("learned.thing.influencer", { label: item.label });
    case "model":
      return item.label === null
        ? tw("learned.thing.modelUnknown")
        : tw("learned.thing.model", { label: item.label });
    case "music.track":
      return item.label === null
        ? tw("learned.thing.musicTrackUnknown")
        : tw("learned.thing.musicTrack", { label: item.label });
    default:
      return null;
  }
}

export interface LearnedPhrase {
  readonly text: string;
  /** «12 of 14»: a favor si le gusta, en contra si lo evita. */
  readonly evidence: string;
}

/**
 * «You accept reaction memes» · «12 of 14». Lo que se evita y se puede editar
 * (fondo, clip, música, estilo, texto) dice «skip or swap»: esas señales
 * vienen también de ediciones.
 */
export function phraseOf(item: LearnedPreference): LearnedPhrase | null {
  const thing = thingOf(item);
  if (thing === null) return null;
  const key: CopyKey =
    item.direction === "likes"
      ? "learned.likes"
      : item.aspect === null
        ? "learned.avoids"
        : "learned.avoidsEditable";
  const count = item.direction === "likes" ? item.accepts : item.total - item.accepts;
  return {
    text: tw(key, { thing }),
    evidence: tw("learned.evidence", { count, total: item.total }),
  };
}
