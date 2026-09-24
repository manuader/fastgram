/**
 * La aritmética del Calendar · F-140..F-143 (PRD:608-611), FR-110 (PRD:1653-1668).
 *
 * Todo lo de este archivo es puro —sin React, sin red, sin `Date.now()`—, así
 * que los bordes de mes y de DST se prueban con números fijos y una zona
 * explícita, no con el reloj ni con la zona de la máquina que corre el test.
 *
 * ## La zona horaria, que decide en qué celda cae un post
 *
 * El PRD guarda `timezone` en el usuario (DATA-001, PRD:2026: *"IANA,
 * sincronizada automáticamente"*) y en el workspace (DATA-002), pero **ningún
 * endpoint de `apps/api` lo publica**: no hay `GET /me` ni un campo `timezone`
 * en ninguna respuesta que la web pueda leer. "Sincronizada automáticamente"
 * es, en el original, desde el navegador — así que la zona del navegador es la
 * mejor aproximación disponible a la del usuario, y es la que se usa.
 *
 * Eso **no** es lo que hace `Library → My Posts`, que fija UTC y lo escribe en
 * el pie (`lib/library/posts.ts`). Las dos decisiones son defendibles por
 * separado y juntas producen una asimetría: un post de las 23:30 UTC en
 * Buenos Aires aparece en la Library como del día 22 y acá en la celda del 22
 * a las 8:30 PM. Por eso la pantalla dice en qué zona está; el día que la API
 * publique la zona del usuario, se pasa acá y las dos pantallas pueden
 * converger.
 *
 * Toda función que dependa de la zona la **recibe**. Ninguna la adivina.
 *
 * ## Qué fecha pone a un post en un día
 *
 * `postedAt` si salió, `scheduledAtUtc` si no. Es el mismo criterio que la
 * tarjeta de la Library (`PostCard`), y por el mismo motivo: un post del carril
 * lento de TikTok (NFR-015) puede salir hasta 72 h después de su hora, y
 * dibujarlo en el día en que *iba* a salir contradice el `✓` que lleva.
 */
import type { Post, PostPlatform, PostStatus } from "@fastgram/contracts";
import type { PlatformTone } from "@fastgram/ui";

// ---------------------------------------------------------------------------
// Mes
// ---------------------------------------------------------------------------

/** Un mes civil. `month` va de 1 a 12, como se escribe, no de 0 a 11 como `Date`. */
export interface YearMonth {
  readonly year: number;
  readonly month: number;
}

/** Una celda de la cuadrícula. `null` es relleno: un día de otro mes. */
export interface DayCell {
  /** `YYYY-MM-DD`, la misma forma que devuelve `dayKeyOf`. */
  readonly key: string;
  readonly day: number;
}

/** Semanas de domingo a sábado: `Su Mo Tu We Th Fr Sa` (PRD:1657). */
export type Week = readonly (DayCell | null)[];

function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
}

export function dayKey(year: number, month: number, day: number): string {
  return `${String(year)}-${pad2(month)}-${pad2(day)}`;
}

/** Suma meses sin pasar por `Date`: diciembre + 1 es enero del año siguiente. */
export function shiftMonth(ym: YearMonth, delta: number): YearMonth {
  const index = ym.year * 12 + (ym.month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function daysInMonth(ym: YearMonth): number {
  // El día 0 del mes siguiente es el último de éste. En UTC: la aritmética de
  // fechas civiles no tiene nada que ver con la zona de nadie.
  return new Date(Date.UTC(ym.year, ym.month, 0)).getUTCDate();
}

/**
 * La cuadrícula del mes: semanas completas de 7, con relleno `null` antes del
 * día 1 y después del último.
 *
 * Los días de los meses vecinos se dejan **en blanco**, no grises con su
 * número. Un 30 gris en la primera fila de octubre invita a buscar ahí los
 * posts del 30 de septiembre, y esta vista no los enseña: la celda de ese día
 * es la del mes anterior.
 */
export function monthGrid(ym: YearMonth): readonly Week[] {
  const firstWeekday = new Date(Date.UTC(ym.year, ym.month - 1, 1)).getUTCDay();
  const total = daysInMonth(ym);
  const cells: (DayCell | null)[] = [];
  for (let i = 0; i < firstWeekday; i += 1) cells.push(null);
  for (let day = 1; day <= total; day += 1) {
    cells.push({ key: dayKey(ym.year, ym.month, day), day });
  }
  while (cells.length % 7 !== 0) cells.push(null);

  const weeks: Week[] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

// ---------------------------------------------------------------------------
// Zona horaria
// ---------------------------------------------------------------------------

const partsFormatters = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = partsFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    partsFormatters.set(timeZone, formatter);
  }
  return formatter;
}

/** El día civil de un instante **en esa zona**, como `YYYY-MM-DD`. */
export function dayKeyOf(msEpoch: number, timeZone: string): string {
  const parts = partsFormatter(timeZone).formatToParts(new Date(msEpoch));
  const get = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return dayKey(get("year"), get("month"), get("day"));
}

/** El mes civil de un instante en esa zona. Es el mes con el que abre la vista. */
export function monthOf(msEpoch: number, timeZone: string): YearMonth {
  const [year, month] = dayKeyOf(msEpoch, timeZone).split("-").map(Number);
  return { year: year ?? 1970, month: month ?? 1 };
}

/**
 * La zona del navegador. Ver la cabecera: es una aproximación a la del usuario,
 * no la del usuario. `UTC` si el runtime no la sabe decir.
 */
export function browserTimeZone(): string {
  try {
    const zone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
    return zone === "" ? "UTC" : zone;
  } catch {
    return "UTC";
  }
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

/**
 * Lo que el reparto necesita de un post. Estructural y no `Pick<Post, …>`: el
 * `_id` del contrato es un id con marca, y los tests de esta aritmética no
 * tienen por qué fabricar posts válidos para probar un orden.
 */
export interface Placeable {
  readonly _id: string;
  readonly scheduledAtUtc: number;
  readonly postedAt?: number | undefined;
}

/** La fecha que pone al post en un día. Ver la cabecera. */
export function postInstant(post: Omit<Placeable, "_id">): number {
  return post.postedAt ?? post.scheduledAtUtc;
}

/**
 * Los posts, repartidos por día y **ordenados por hora** dentro de cada uno
 * (FR-110, criterio de aceptación 2). El `_id` desempata para que dos posts a
 * la misma hora no cambien de lugar entre dos renders.
 */
export function groupByDay<T extends Placeable>(
  posts: readonly T[],
  timeZone: string,
): ReadonlyMap<string, readonly T[]> {
  const byDay = new Map<string, T[]>();
  for (const post of posts) {
    const key = dayKeyOf(postInstant(post), timeZone);
    const bucket = byDay.get(key);
    if (bucket === undefined) byDay.set(key, [post]);
    else bucket.push(post);
  }
  for (const bucket of byDay.values()) {
    bucket.sort((a, b) => {
      const diff = postInstant(a) - postInstant(b);
      if (diff !== 0) return diff;
      return a._id < b._id ? -1 : a._id > b._id ? 1 : 0;
    });
  }
  return byDay;
}

/**
 * ¿Cuántos posts caen en este mes? Sólo lo que la vista enseña: decide el
 * estado vacío.
 */
export function countInMonth(
  byDay: ReadonlyMap<string, readonly unknown[]>,
  ym: YearMonth,
): number {
  const prefix = `${String(ym.year)}-${pad2(ym.month)}-`;
  let total = 0;
  for (const [key, bucket] of byDay) if (key.startsWith(prefix)) total += bucket.length;
  return total;
}

/**
 * Los tres contadores de cabecera · F-143 (PRD:611), FR-110 (PRD:1655):
 * `✓` publicados, `📥` inbox, `📅` programados.
 *
 * Son **globales**, no del mes: el PRD los llama así, y en la captura (`✓ 36`
 * con un mes que enseña bastante menos) no pueden ser del mes.
 *
 * Qué estado cuenta en cuál es una decisión, porque el PRD nombra tres cajas y
 * FR-060 tiene diez estados:
 *
 * · `✓` = `POSTED`.
 * · `📥` = `IN_USER_INBOX` — PRD:1390, TikTok lo aceptó y espera al usuario.
 * · `📅` = `SCHEDULED` **y `BUILDING`**. Un post en `BUILDING` es uno que el
 *   usuario programó y cuyo media todavía se está construyendo (PRD:1378): para
 *   quien lo programó está programado. Dejarlo fuera haría que el contador
 *   baje al programar y suba minutos después, sin que el usuario haga nada.
 *
 * El resto (`FAILED`, `CANCELLED`, `UPLOADING_TO_TIKTOK`, …) no cuenta en
 * ninguno: no es ninguna de las tres cosas que la cabecera nombra.
 */
export interface HeaderCounts {
  readonly posted: number;
  readonly inbox: number;
  readonly scheduled: number;
}

export const HEADER_COUNTER_STATUSES: Readonly<
  Record<keyof HeaderCounts, readonly PostStatus[]>
> = {
  posted: ["POSTED"],
  inbox: ["IN_USER_INBOX"],
  scheduled: ["SCHEDULED", "BUILDING"],
};

export function headerCounts(posts: readonly Pick<Post, "status">[]): HeaderCounts {
  const count = (statuses: readonly PostStatus[]): number =>
    posts.filter((post) => statuses.includes(post.status)).length;
  return {
    posted: count(HEADER_COUNTER_STATUSES.posted),
    inbox: count(HEADER_COUNTER_STATUSES.inbox),
    scheduled: count(HEADER_COUNTER_STATUSES.scheduled),
  };
}

/**
 * Plataforma → tono de `@fastgram/ui`. Tipado contra `PlatformTone` y no con un
 * `as`: si el contrato agrega una plataforma que la paleta no tiene, esto deja
 * de compilar en vez de pintar un chip sin color.
 */
export const PLATFORM_CHIP_TONE: Readonly<Record<PostPlatform, PlatformTone>> = {
  tiktok: "tiktok",
  instagram: "instagram",
  youtube: "youtube",
  reddit: "reddit",
  x: "x",
  threads: "threads",
  facebook: "facebook",
};

// ---------------------------------------------------------------------------
// Formato
// ---------------------------------------------------------------------------

/** `September 2026` — el `MMMM YYYY` de F-140. En inglés: el resto del copy lo está. */
const monthTitleFormat = new Intl.DateTimeFormat("en-US", {
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

export function formatMonthTitle(ym: YearMonth): string {
  return monthTitleFormat.format(new Date(Date.UTC(ym.year, ym.month - 1, 1)));
}

/** `Tuesday, September 22` — el nombre de una celda para un lector de pantalla. */
const dayLabelFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "long",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});

export function formatDayLabel(key: string): string {
  const [year, month, day] = key.split("-").map(Number);
  return dayLabelFormat.format(
    new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)),
  );
}

const chipTimeFormatters = new Map<string, Intl.DateTimeFormat>();

/**
 * `11:56 PM` — la hora del chip (PRD:1659), en la zona de la vista.
 *
 * Mayúsculas porque así la escribe FR-110; la Library usa `am/pm` porque así
 * la escribe PRD:1608. Son dos pantallas del original con dos formatos.
 */
export function formatChipTime(msEpoch: number, timeZone: string): string {
  let formatter = chipTimeFormatters.get(timeZone);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat("en-US", {
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZone,
    });
    chipTimeFormatters.set(timeZone, formatter);
  }
  // Mismo motivo que `formatPostTime`: según la versión de Node/ICU, el espacio
  // antes de `PM` es U+202F. Se normaliza para que el texto sea uno solo.
  return formatter.format(new Date(msEpoch)).replace(/\s+/g, " ");
}
