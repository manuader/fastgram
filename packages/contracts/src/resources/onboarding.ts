/**
 * Onboarding — `FR-010` (PRD:735-790), `FLOW-001` (PRD:1885), `FLOW-009`
 * (PRD:1990), `DATA-030` (PRD:2185), `F-004`…`F-008` (PRD:432-436).
 *
 * ## Lo primero que hay que saber: el PRD no define estos endpoints
 *
 * La **superficie completa v1** de §9.3 son 29 endpoints y **ninguno es de
 * onboarding**; §9.14 —la única sección que enumera rutas nuevas— define las
 * siete de `/brand/*`. O sea que `FR-010` especifica un wizard de cinco pasos,
 * su copy de validación literal y su comportamiento de sistema, y **no dice por
 * qué cable viaja**. La API original de Fastlane es server-to-server para
 * integradores; el wizard lo consume su propio front.
 *
 * Así que la forma de estos tres endpoints es **derivada**, no copiada, y el
 * criterio fue: no inventar ni un campo que no esté en `FR-010` o en
 * `DATA-030`, y no inventar **ninguna operación** cuyo caso de uso no esté
 * escrito en `packages/core/src/onboarding/onboarding.ts`. Lo que el PRD pide y
 * el dominio todavía no sabe hacer —crear el workspace, la rama manual, el paso
 * de detalles— **no está acá**: está en el reporte.
 *
 *   GET  /onboarding             dónde retomar el wizard (`resumeOnboarding`)
 *   POST /onboarding/profiling   el cuestionario de `F-006` (`assertValidProfiling`)
 *   POST /onboarding/complete    el cierre de `FR-010` **System behavior**
 *
 * ## Los nombres de los campos del cuestionario
 *
 * `packages/core` llama a las respuestas `role` y `monthlyRevenue`; `DATA-004`
 * y `companyProfileSchema` llaman a las mismas dos cosas `ownerRole` y
 * `monthlyRevenueBand`. **Por el cable van los del contrato**, porque un campo
 * con dos nombres en la misma v1 —uno en `GET /brand/profile` y otro en
 * `POST /onboarding/profiling`— es una pregunta que todo integrador tiene que
 * hacerse una vez. La traducción a las claves de `core` la hace la ruta.
 *
 * ## Por qué el request del cuestionario casi no valida
 *
 * Porque validar acá **le robaría el mensaje al dominio**. `FR-010` fija copy
 * literal por campo (*"Please select your role"*, *"Please select at least one
 * business category"*), y esa copy vive en `REQUIRED_PROFILING_ANSWERS` de
 * `core`. Un `.min(1)` en este schema haría que Fastify rechazara antes, con su
 * error genérico, y la copy CONFIRMED del PRD no se mostraría nunca.
 *
 * Lo que este schema **sí** exige es que **las seis claves estén presentes**,
 * incluida `expectations`. Ver el comentario de
 * {@link submitOnboardingProfilingRequestSchema}: es la mitad de `P1-ONB-004`
 * que se puede cerrar sin inventar copy.
 */
import { z } from "zod";

import { brandSourceSchema } from "./brand.js";

// --- Números del PRD ---------------------------------------------------------

/** `FR-010` (PRD:767) — *"Each answer is limited to 4,000 characters."* */
export const ONBOARDING_ANSWER_MAX_CHARS = 4000;
/** `FR-010` (PRD:767) — *"Company name must be at least 2 characters"*. */
export const ONBOARDING_COMPANY_NAME_MIN_CHARS = 2;

// --- Pasos · FR-010 ----------------------------------------------------------

/**
 * Los cinco pasos observados en `[APP OnboardingPage]` (PRD:741-749).
 *
 * El orden es el del wizard y **es parte del contrato**: un cliente que guarda
 * el paso y vuelve compara contra esta lista para saber si avanzó o retrocedió.
 */
export const ONBOARDING_STEPS = [
  "brand_source",
  "company_details",
  "profiling",
  "processing",
  "ready",
] as const;
export const onboardingStepSchema = z.enum(ONBOARDING_STEPS);
export type OnboardingStep = z.infer<typeof onboardingStepSchema>;

// --- Recurso -----------------------------------------------------------------

/**
 * Paso 2 del wizard (PRD:743). `logoUrl` es `null` mientras no haya logo:
 * `Company Logo (optional)` es literal del PRD.
 */
export const onboardingDetailsSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    logoUrl: z.string().url().nullable(),
  })
  .strict();
export type OnboardingDetails = z.infer<typeof onboardingDetailsSchema>;

/** Paso 3 del wizard — las seis preguntas de `F-006` (PRD:434, PRD:744). */
export const onboardingProfilingSchema = z
  .object({
    ownerRole: z.string(),
    teamSize: z.string(),
    businessModel: z.string(),
    businessCategories: z.array(z.string()),
    monthlyRevenueBand: z.string(),
    expectations: z.array(z.string()),
  })
  .strict();
export type OnboardingProfiling = z.infer<typeof onboardingProfilingSchema>;

/**
 * El estado del wizard — `DATA-030` + lo que `FR-010` criterio 3 exige poder
 * reanudar (*"Recargar la página a mitad del wizard conserva el progreso"*).
 *
 * `details` y `profiling` son **nullable y no opcionales**: `null` significa
 * *"ese paso todavía no se respondió"*, que es información, no ausencia de
 * campo. Un cliente que reanuda necesita distinguirlo de `{}`.
 *
 * `oauthConsents` está en el cuerpo por `D-01` / `FLOW-009` criterio 11:
 * *"completar el alta con una fuente social no requiere autorizar OAuth en
 * ningún momento"*. Publicarlo es lo que permite que un cliente —o un test de
 * aceptación— lo **afirme** en vez de confiar en que nadie metió un `Connect`
 * obligatorio en el camino.
 */
export const onboardingStateSchema = z
  .object({
    step: onboardingStepSchema,
    sources: z.array(brandSourceSchema),
    /** `Use description instead` (PRD:753). Ver la nota de la ruta. */
    manualBranch: z.boolean(),
    details: onboardingDetailsSchema.nullable(),
    profiling: onboardingProfilingSchema.nullable(),
    oauthConsents: z.number().int().nonnegative(),
  })
  .strict();
export type OnboardingState = z.infer<typeof onboardingStateSchema>;

// --- Requests ----------------------------------------------------------------

/**
 * `POST /onboarding/profiling` — el cuestionario de `F-006`.
 *
 * ## Las seis claves son obligatorias; sus **valores** los juzga el dominio
 *
 * `REQUIRED_PROFILING_ANSWERS` de `packages/core` exige cinco respuestas no
 * vacías —rol, equipo, modelo, categorías e ingresos— y **no exige
 * `expectations`**. Eso no es un olvido: la lista de **Validation** de `FR-010`
 * (PRD:767) trae un mensaje de error para cada una de las cinco y **ninguno
 * para expectativas**. El PRD la pide como pregunta (`What do you expect from
 * the platform? Select all that apply`) y no da copy para rechazarla vacía.
 *
 * Así que la sexta pregunta se cierra por donde se puede cerrar sin inventar
 * copy: **la clave tiene que venir**. Un cuerpo sin `expectations` es un 400
 * del schema, y uno con `expectations: []` pasa y se guarda vacío. Con eso la
 * respuesta deja de poder perderse en silencio —que era el agujero real: un
 * cliente que nunca la mandaba dejaba la columna vacía para siempre sin que
 * nada lo dijera— y no se inventa un *"Please select at least one expectation"*
 * que el PRD no escribió.
 *
 * Su **longitud** sí se valida, y la valida `assertValidProfiling`: el bucle de
 * 4 000 caracteres recorre **todas** las respuestas que se le pasen, no sólo
 * las cinco obligatorias. O sea que la mitad de `P1-ONB-004` que faltaba
 * (recoger y acotar la sexta) queda cerrada, y la otra mitad (hacerla
 * obligatoria) queda declarada como lo que es: una decisión de producto sin
 * respaldo en el PRD.
 */
export const submitOnboardingProfilingRequestSchema = z
  .object({
    ownerRole: z.string(),
    teamSize: z.string(),
    businessModel: z.string(),
    businessCategories: z.array(z.string()),
    monthlyRevenueBand: z.string(),
    expectations: z.array(z.string()),
  })
  .strict();
export type SubmitOnboardingProfilingRequest = z.infer<
  typeof submitOnboardingProfilingRequestSchema
>;

/**
 * `POST /onboarding/complete` — el cierre del wizard.
 *
 * `FR-010` **System behavior** (PRD:759): *"Al finalizar: crear el workspace
 * real, sembrar content angles iniciales, **arrancar el relleno de la discovery
 * queue** y marcar onboarding como completo."* Lo mismo dicen `FLOW-001`
 * (PRD:1890) y `FLOW-009` (PRD:2006).
 *
 * De los cuatro efectos, hoy se ejecutan tres: el workspace lo crea antes
 * `POST /onboarding/workspace`; marcar completo es la transición
 * `draft → active` de este mismo cierre (que por eso devuelve `step: "ready"`);
 * y el relleno se encola en la misma transacción. Sembrar ángulos **no** tiene
 * ejecutor todavía (necesita el generador de `AI-005`).
 *
 * `discoveryRefillQueued` dice si **esta** llamada encoló el relleno. El cierre
 * es idempotente: repetirlo sobre un alta ya cerrada devuelve `202` con el
 * mismo `ready` y `false`, porque el relleno ya lo pidió el primero. No es un
 * `true` fijo: un `false` en el primer cierre diría que `/home` va a llegar vacío.
 */
export const onboardingCompletionSchema = onboardingStateSchema
  .extend({ discoveryRefillQueued: z.boolean() })
  .strict();
export type OnboardingCompletion = z.infer<typeof onboardingCompletionSchema>;
