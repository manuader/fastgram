/**
 * Connections · `GET /connections` (PRD:2270).
 *
 * Fuente: DATA-016 (PRD:2117), NFR-007 (PRD:2957).
 *
 * `accessToken` y `refreshToken` están cifrados y **nunca se exponen**
 * (DATA-016, PRD:2117): no aparecen en este schema, que es el contrato público.
 */
import { z } from "zod";
import { connectionStatusSchema, platformSchema } from "../primitives/enums";
import { connectionIdSchema, msEpochSchema } from "../primitives/ids";

export const connectionSchema = z
  .object({
    _id: connectionIdSchema,
    platform: platformSchema,
    platformUserId: z.string().min(1),
    platformUsername: z.string().min(1),
    scopes: z.array(z.string()),
    publishable: z.boolean(),
    tokenExpiry: msEpochSchema,
    status: connectionStatusSchema,
    createdAt: msEpochSchema,
    updatedAt: msEpochSchema,
  })
  .strict();
export type Connection = z.infer<typeof connectionSchema>;
