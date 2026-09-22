-- `posts.external_post_id` — el id del post **en la plataforma**.
-- `NFR-015`, `DATA-020`, y el puerto `SocialPublisher`.
--
-- ## Por qué esto es una migración aparte y no parte de `0007`
--
-- Porque son dos hechos distintos. Una migración llamada `influencer_credits`
-- que además le agrega una columna a `posts` es la clase de cambio que después
-- nadie encuentra. Van separadas y cada una se explica sola.
--
-- ## El agujero, con el mecanismo
--
-- `posts` guarda `post_url` —el permalink, que es para el usuario— y nada más.
-- El puerto `SocialPublisher` pide otra cosa para volver a hablar con la
-- plataforma:
--
--   interface PublishRef { account: PublishAccountRef; externalPostId: string }
--
-- y `getStatus(ref)`, `cancel(ref)` y `fetchMetrics(refs)` lo toman los tres. Sin
-- una columna donde guardarlo, el `externalPostId` que devuelve `publish()` vive
-- lo que vive el proceso del handler y después no existe.
--
-- Lo que eso rompe, concretamente:
--
--  - **El carril lento de TikTok (`NFR-015`, hasta 72 h).** El watcher tiene que
--    volver a preguntar por un post que quedó `processing` / `IN_USER_INBOX`, y
--    no tendría con qué. No falla: simplemente no puede arrancar.
--  - **`cancel`.** Cancelar un post ya entregado a la plataforma necesita el
--    mismo ref.
--  - **La sincronización de métricas (`NFR-016`).** `fetchMetrics` devuelve las
--    filas indexadas por `externalPostId`; sin la columna no hay cómo atribuir
--    cada resultado a su `posts.id`.
--
-- Es el mismo tipo de agujero que `0007` cierra para los créditos: un dato que
-- sólo existe mientras el handler corre, y que después no se puede recuperar
-- desde ningún lado.
--
-- ## El nombre no se inventa
--
-- `DATA-020` no enumera este campo, así que por la regla de este schema habría
-- que no inventarlo. No hace falta: `externalPostId` es el nombre que ya usa el
-- puerto (`packages/ports/src/social-publisher.ts`), que es el contrato con el
-- que esta columna se llena y se lee. Un nombre nuevo sería un tercer término
-- para la misma cosa.
--
-- ## Nullable, y sin índice
--
-- `NULL` mientras el post no llegó a la plataforma: `SCHEDULED` no tiene id
-- externo, y el puerto lo dice igual (*"presente desde `processing` en
-- adelante"*). Un default vacío no distinguiría "todavía no salió" de "salió y
-- no lo guardamos".
--
-- No lleva índice **a propósito**: no hay camino de lectura que entre por acá.
-- Todo acceso a `posts` arranca por `company_id` (IMPL §2.4), y el
-- `external_post_id` se usa para hablar con la plataforma sobre una fila que ya
-- se encontró, no para encontrarla. Un índice acá invitaría además a buscar por
-- él **sin tenant**, que es justo lo que el resto del paquete impide.

ALTER TABLE "posts" ADD COLUMN "external_post_id" text;

COMMENT ON COLUMN "posts"."external_post_id" IS
  'Id del post en la plataforma, tal como lo nombra el puerto SocialPublisher. '
  'Es lo que PublishRef necesita para getStatus/cancel/fetchMetrics; sin esto el '
  'watcher del carril lento de TikTok (NFR-015, hasta 72 h) no tiene con que '
  'volver a preguntar. NULL mientras el post no llego a la plataforma. No es el '
  'permalink: eso es post_url, y es para el usuario.';
