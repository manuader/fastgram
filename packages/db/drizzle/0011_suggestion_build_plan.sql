-- `suggestions.build_plan` — con qué se construye una sugerencia de Blitz.
-- `AI-002`, `FR-050`, `FR-070`, `DATA-007`.
--
-- ## El agujero, medido
--
-- Con API + web + worker levantados, Blitz hacía el ciclo completo (cola vacía
-- → `discovery-refill` → `POST /blitz` cobra y encola `content-build`) y la
-- pieza terminaba `FAILED` con `invalid_build_payload` (`buildPayload no cumple
-- el contrato: invalid_union`), con el save reembolsado. `DATA-007` no le da a
-- una `Suggestion` nada con qué construir: `contentType`, `generatedText`,
-- `aiExplanation` y un puñado de ids. La media concreta y los textos por slide
-- no tenían dónde vivir, y `POST /blitz` creaba el `Content` sin payload.
--
-- ## Qué guarda
--
-- Un `jsonb` con la forma `SuggestionBuildPlan` de `packages/core`
-- (`discovery/blitz-build.ts`): `{version, media, texts}`. La media es
-- `{mediaId, url}` por rol —el id para verificar al aceptar que sigue viva, la
-- URL para el payload—, y `texts` es la copy del LLM (un texto por slide).
--
-- Lo que depende de la petición **no** se guarda: el canvas del slideshow sale
-- del `aspectRatio` de `POST /blitz`, y el look del texto de
-- `text_style_preset_id`, que ya es columna.
--
-- ## Por qué un `jsonb` y no columnas
--
-- La forma cambia por formato (N slides, o fondo + clip, o hook + demo). Cuatro
-- juegos de columnas nulas serían cuatro invariantes que la base no puede
-- sostener mejor que el parser de `core`, que igual hace falta para leerlo.
--
-- ## Nullable, sin default, sin backfill
--
-- `NULL` es exactamente «sugerencia planificada antes de esto»: no tiene media
-- elegida ni copy, y **no se puede reconstruir** sin volver a tirar el dado y
-- llamar al LLM. `POST /blitz` la descarta con `422 content_unavailable_for_type`
-- **antes** de cobrar, y la cola se rellena con sugerencias nuevas. Un backfill
-- inventaría una elección que nadie hizo.

ALTER TABLE "suggestions" ADD COLUMN "build_plan" jsonb;

COMMENT ON COLUMN "suggestions"."build_plan" IS
  'Con que se construye la pieza: SuggestionBuildPlan de core '
  '({version, media, texts}). La media es {mediaId, url} por rol, del Media Bank '
  'del workspace; texts es la copy (uno por slide). NULL = sugerencia anterior a '
  'la migracion 0011: POST /blitz la descarta antes de cobrar. No esta en DATA-007.';
