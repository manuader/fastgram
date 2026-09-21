-- Extensiones de Postgres — ADR-003, P1-DATA-013.
--
-- `vector` se habilita ahora aunque ninguna tabla lo use todavía: lo necesita la
-- deduplicación de `no_unique_content` (PRD FR-150) en Fase 3, y habilitar una
-- extensión suele requerir privilegios que el rol de aplicación no va a tener en
-- producción. Hacerlo en la migración inicial evita un pedido a operaciones en medio
-- de una fase posterior.
--
-- La imagen de desarrollo (`docker-compose.yml`) es `pgvector/pgvector:pg17`, que ya la
-- trae. Los tests de integración usan la misma imagen justamente por esto.

CREATE EXTENSION IF NOT EXISTS "vector";
--> statement-breakpoint
-- `gen_random_uuid()` viene con pgcrypto en <13 y con el core desde 13. Se declara
-- igual para que la migración no dependa de la versión del servidor.
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
