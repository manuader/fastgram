/**
 * El payload del job `influencer-pipeline` — PRD §9.5 #5, `FR-080`.
 *
 * Mismo criterio que `content-build.ts` y `publish.ts`: el payload vuelve de la
 * cola como `unknown` y un `as` ahí es una mentira que el compilador no puede
 * desmentir.
 *
 * ## Por qué éste sí lleva datos y no sólo ids
 *
 * Al revés que el de `publishing`, que lleva **sólo** a quién releer para que un
 * `Reschedule` no publique lo viejo. Acá los rasgos del personaje —nombre,
 * género, edad, etnia, detalles— son **la entrada del generador**, no estado
 * mutable: describen lo que se pidió generar en el momento en que se pidió, y
 * releerlos después daría lo mismo porque nadie los edita durante el pipeline.
 * `additionalDetails` ni siquiera está en `DATA-013`: es entrada y no estado, y
 * por eso viaja acá y no en la fila.
 *
 * `creditsPeriod` y `creditsCharged` viajan para que el handler sepa si hay algo
 * que devolver **sin leer la fila primero**. Siguen estando en `influencers`,
 * que es la fuente de verdad y la que tiene la guarda contra el doble
 * reembolso; esto es una copia para decidir rápido, no para decidir solo.
 */

/** Lo que viaja en la cola `influencer-pipeline`. */
export interface InfluencerPipelineJob {
  readonly companyId: string;
  readonly influencerId: string;
  readonly name?: string | undefined;
  readonly gender?: string | undefined;
  readonly age?: number | undefined;
  readonly ethnicity?: string | undefined;
  readonly additionalDetails?: string | undefined;
  readonly baseImageUrl?: string | undefined;
  /** El período al que se cobró. Ver el encabezado. */
  readonly creditsPeriod?: string | undefined;
  readonly creditsCharged?: number | undefined;
}

export type ParsedInfluencerPipelineJob =
  | { readonly ok: true; readonly payload: InfluencerPipelineJob }
  | { readonly ok: false; readonly reason: string };

function cadenaOpcional(
  source: Record<string, unknown>,
  key: string,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  const raw = source[key];
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string" || raw.length === 0)
    return { ok: false, reason: `${key} must be a non-empty string when present` };
  return { ok: true, value: raw };
}

export function parseInfluencerPipelineJob(raw: unknown): ParsedInfluencerPipelineJob {
  if (typeof raw !== "object" || raw === null)
    return { ok: false, reason: "payload is not an object" };
  const source = raw as Record<string, unknown>;

  const { companyId, influencerId } = source;
  if (typeof companyId !== "string" || companyId.length === 0)
    return { ok: false, reason: "companyId is missing" };
  if (typeof influencerId !== "string" || influencerId.length === 0)
    return { ok: false, reason: "influencerId is missing" };

  const opcionales = [
    "name",
    "gender",
    "ethnicity",
    "additionalDetails",
    "baseImageUrl",
    "creditsPeriod",
  ] as const;
  const valores: Record<string, string | undefined> = {};
  for (const key of opcionales) {
    const r = cadenaOpcional(source, key);
    if (!r.ok) return { ok: false, reason: r.reason };
    valores[key] = r.value;
  }

  const age = source["age"];
  if (
    age !== undefined &&
    age !== null &&
    (!Number.isInteger(age) || (age as number) < 0)
  )
    return { ok: false, reason: "age must be a non-negative integer when present" };

  const charged = source["creditsCharged"];
  // Un `creditsCharged` fraccionario o negativo devolvería una cantidad
  // equivocada y el CHECK de contadores no negativos haría fallar la
  // transacción entera, dejando el personaje sin cerrar.
  if (
    charged !== undefined &&
    charged !== null &&
    (!Number.isInteger(charged) || (charged as number) < 0)
  )
    return {
      ok: false,
      reason: "creditsCharged must be a non-negative integer when present",
    };

  return {
    ok: true,
    payload: {
      companyId,
      influencerId,
      name: valores["name"],
      gender: valores["gender"],
      age: age === undefined || age === null ? undefined : (age as number),
      ethnicity: valores["ethnicity"],
      additionalDetails: valores["additionalDetails"],
      baseImageUrl: valores["baseImageUrl"],
      creditsPeriod: valores["creditsPeriod"],
      creditsCharged:
        charged === undefined || charged === null ? undefined : (charged as number),
    },
  };
}
