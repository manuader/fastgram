-- Privilegios del rol de la aplicación sobre el esquema de pg-boss — `ADR-005`.
--
-- ## El problema, medido
--
-- El encolado transaccional de IMPL §2.3 ocurre **dentro** de `withCompany(...)`,
-- o sea con `SET LOCAL ROLE fastgram_app`. pg-boss crea su propio esquema y sus
-- tablas con el usuario de su pool, que es el dueño; `fastgram_app` no recibe
-- nada. El resultado, reproducido a mano:
--
--     BEGIN; SET LOCAL ROLE fastgram_app;
--     INSERT INTO pgboss.job (...);
--     ERROR:  permission denied for schema pgboss
--
-- Y es otra vez la misma trampa que el bootstrap de API keys (migración `0003`):
-- **en desarrollo funciona**, porque ahí la conexión es superusuario y
-- `DATABASE_APP_ROLE` suele estar vacío. En producción, toda ruta que encole
-- —crear contenido, crear influencer, programar un post, aceptar un Blitz—
-- falla. Es la tercera vez que aparece este patrón en el proyecto; vale
-- anotarlo como clase, no como incidente.
--
-- ## Por qué `ALTER DEFAULT PRIVILEGES` y no un `GRANT ... ON ALL TABLES`
--
-- Por orden de ejecución. Esta migración corre con las de Drizzle, en el deploy;
-- pg-boss crea sus tablas cuando **él** migra, que es después y en otro proceso.
-- Un `GRANT ON ALL TABLES` acá no encontraría ninguna tabla y no fallaría: sólo
-- no haría nada, que es peor.
--
-- Así que se crea el esquema primero —el `CREATE SCHEMA IF NOT EXISTS` de
-- pg-boss lo encuentra hecho y sigue— y se dejan puestos los privilegios por
-- defecto, que aplican a lo que el dueño cree ahí **después**.
--
-- ## El nombre del esquema
--
-- `pgboss` es el default de pg-boss y el de `QUEUE_SCHEMA`. Si alguien lo cambia
-- por entorno, **hay que repetir estos grants para el esquema nuevo**: no hay
-- forma de parametrizar una migración SQL, y un grant sobre el esquema
-- equivocado no falla, simplemente no sirve. Queda como trampa en el handoff.

CREATE SCHEMA IF NOT EXISTS "pgboss";

GRANT USAGE ON SCHEMA "pgboss" TO "fastgram_app";

-- Para las tablas que pg-boss ya haya creado (re-migración sobre una base viva).
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "pgboss" TO "fastgram_app";
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "pgboss" TO "fastgram_app";

-- Y para las que cree después, que es el caso normal en una base nueva.
-- `FOR ROLE CURRENT_USER`: los privilegios por defecto son por rol creador, y el
-- que va a crear las tablas de pg-boss es el mismo que corre esta migración.
ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA "pgboss"
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO "fastgram_app";

ALTER DEFAULT PRIVILEGES FOR ROLE CURRENT_USER IN SCHEMA "pgboss"
  GRANT USAGE, SELECT ON SEQUENCES TO "fastgram_app";
