-- 0038 · Sprint 9 (`PU-S9-010`, `D-20`): el formato `reel`.
--
-- Un reel es una composición por capas renderizada con HyperFrames. Su
-- `build_payload` es `{ "reel": <ReelSpec> }` y las ediciones del editor por
-- capas viven en `studio_state.reel` (el payload no se reescribe, igual que el
-- resto de los formatos). No hace falta columna nueva: sólo el valor de enum.
--
-- Se agrega también a `suggestion_content_type` para que el planificador
-- semanal (segunda tanda) pueda encolar reels sin otra migración; hasta
-- entonces ninguna sugerencia lo usa (el tipo TS de la cola no lo incluye).
--
-- ## Por qué sin usar `reel` acá
--
-- Igual que `0013` y `0029`: Drizzle corre todas las migraciones en una
-- transacción y un valor nuevo de enum no se puede nombrar hasta que commitea.
-- `IF NOT EXISTS` para que re-correrla sobre una base que ya lo tiene no falle.

ALTER TYPE "content_type" ADD VALUE IF NOT EXISTS 'reel';
--> statement-breakpoint
ALTER TYPE "suggestion_content_type" ADD VALUE IF NOT EXISTS 'reel';
