/**
 * Audio · `GET /audio?for=wall-of-text|video-hook` (PRD:2272).
 *
 * Fuente: FR-053 (PRD:1261-1272), DATA-012 (PRD:2098).
 *
 * El catálogo es **global**, compartido por todos los workspaces y curado por
 * tipo de contenido. El Media Bank no acepta subidas de audio (PRD:1271).
 */
import { z } from "zod";
import { audioLibrarySchema } from "../primitives/enums";
import { audioIdSchema } from "../primitives/ids";
import { cursorQuerySchema } from "../primitives/pagination";

/** `for` es obligatorio: los dos catálogos son distintos (FR-053, PRD:1268). */
export const listAudioQuerySchema = cursorQuerySchema
  .extend({ for: audioLibrarySchema })
  .strict();
export type ListAudioQuery = z.infer<typeof listAudioQuerySchema>;

export const audioTrackSchema = z
  .object({
    audioId: audioIdSchema,
    url: z.string().url(),
    description: z.string(),
    sizeMb: z.number().nonnegative(),
    durationSec: z.number().nonnegative().optional(),
    library: audioLibrarySchema,
  })
  .strict();
export type AudioTrack = z.infer<typeof audioTrackSchema>;
