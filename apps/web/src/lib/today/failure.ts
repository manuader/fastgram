/**
 * Por qué falló un post de "Today" · `PU-UI-002`, FR-060.
 *
 * `CalendarItem` trae `errorCode` y `errorMessage` de los posts `FAILED` de
 * cualquier marca. El orden:
 *
 * 1. Un `errorCode` que el mapa de errores de la web (`FAILURE_COPY_KEYS`,
 *    sección "Programación y publicación") ya sabe decir → ese copy. Sólo los
 *    que describen un **post** fallido: los de validación del pedido
 *    (`privacy_level_required`, …) no pueden quedar guardados en un post.
 * 2. Si no, `errorMessage`, que FR-060 declara *"siempre seguro de mostrar"*
 *    (el mismo criterio de `PostCard`).
 * 3. Si no hay ninguno, un texto que manda a la pieza.
 *
 * `rate_limited` **no** entra en 1 a propósito: el copy de la web es el de
 * ERR-R01 ("API rate limit exceeded"), que en un post fallido se lee como un
 * problema nuestro. El mensaje del post lo dice mejor.
 */
import type { CalendarItem } from "@fastgram/contracts";
import { FAILURE_COPY_KEYS, type FailureCode } from "../api/errors";
import { tw } from "../i18n/t";

const POST_FAILURE_CODES: ReadonlySet<string> = new Set<FailureCode>([
  "tiktok_post_limit_exceeded",
  "youtube_post_limit_exceeded",
  "instagram_post_limit_exceeded",
  "tiktok_creator_info_unavailable",
]);

export function failureReason(
  item: Pick<CalendarItem, "errorCode" | "errorMessage">,
): string {
  const code = item.errorCode;
  if (code !== undefined && POST_FAILURE_CODES.has(code)) {
    return tw(FAILURE_COPY_KEYS[code as FailureCode]);
  }
  return item.errorMessage ?? tw("today.failedFallback");
}
