-- `width_percent` admite decimales (2026-09-24).
--
-- El contrato (`contentTextBoxSchema.widthPercent`) acepta cualquier número en
-- 25–100 y el editor deriva el ancho de un payload en px: 800 px sobre 1080 son
-- 74,074074 %. Con la columna `integer`, el primer PATCH de una pieza así moría
-- con un error de Postgres, y el regenerate también (lo encontró el agente de
-- regenerate). `double precision` y no `numeric`: `postgres-js` devuelve
-- `float8` como número y `numeric` como string, y ningún consumidor espera un
-- string. El CHECK de rango no cambia.
ALTER TABLE "content_text_boxes"
  ALTER COLUMN "width_percent" TYPE double precision USING "width_percent"::double precision;
