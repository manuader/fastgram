# Sesión 2026-09-21 (tarde) — Escritura en los repositorios, los 16 endpoints, y lo que no funcionaba

> Detalle y **porqué**. Lo que queda abierto está en `handoffs/`; el estado general, en
> `docs/HANDOFF.md`.

## 0. De qué se trató

Una cosa desbloqueaba todo lo demás: los 28 repositorios eran de sólo lectura. Como
`drizzle-orm` no es alcanzable desde `apps/api` —ni debe serlo, porque ahí el aislamiento por
tenant pasa a depender de que nadie se olvide un `WHERE`— no había forma de implementar
ninguna escritura. 16 endpoints de la API v1 esperando por eso.

Se resolvió primero eso (`P1-DATA-014`), después los 16 endpoints con cuatro agentes en
paralelo, y en el medio aparecieron **tres cosas que no funcionaban y que nadie sabía**.

## 1. `P1-DATA-014` — escritura con scope

### La propiedad, que es más fuerte que una convención

`create(exec, scope, values)` y `update(exec, scope, id, patch)` **no tienen `companyId` en el
tipo de `values`**. No es que no debas crear una fila en otro workspace: es que no hay dónde
escribir el campo. El repositorio lo inyecta desde el scope; un patch que lo traiga —porque
vino de un body JSON, donde el tipo no mira— se rechaza con un error que lo nombra.

### El filtro es data, no SQL

`ListOptions.where` pedía un `SQL` de Drizzle, y eso lo volvía inusable desde las rutas. El
resultado concreto era que `GET /content?type=`, `GET /media?type=` y `GET /posts?status=`
devolvían `400 bad_request` diciendo "todavía no se puede filtrar".

`{ type: { in: [...] } }` es un objeto plano sin una sola referencia a Drizzle. Operadores
explícitos y no "escalar = igual, array = in", que es más corto y tiene un modo de falla
silencioso: varias columnas del schema son `jsonb`, Drizzle las tipa como `unknown`, y un
valor que *es* un array —`angleWeights`, `position`— se interpretaría como un `IN` de sus
elementos. Consulta válida, sin error, resultado equivocado.

**`{ in: [] }` no coincide con nada.** `IN ()` es un error de sintaxis en Postgres, así que
hay que elegir; la alternativa —omitir la condición— convierte "filtrame por esta lista vacía"
en "traeme todo el workspace", que es exactamente la respuesta que nadie pidió y que no se
nota hasta que alguien mira la lista.

### El `setWhere` del upsert, y lo que la medición corrigió

`content_text_boxes` resuelve el conflicto por `(contentId, id)` y `influencer_configs` por
`influencerId`: **`companyId` no está en el target**. Sin un `setWhere`, el `ON CONFLICT`
resolvería en un UPDATE sobre la fila ajena, y con ids adivinables (`slide-0-text-0`) eso es un
vector real.

Escribí en el comentario que RLS no protegía ese camino. **Lo medí y es falso**: quitando el
`setWhere`, Postgres tira *"new row violates row-level security policy (USING expression)"*. La
capa 1 sostiene. Lo que cambia es **la forma del fallo**: una excepción de base sale como
`500`, y un `500` que aparece **sólo en los ids que existen en otro workspace** es justamente
el canal lateral que §9.2 cierra pidiendo 404 y no 403. Con el `setWhere`, `returning()` vuelve
vacío, el método devuelve `null`, y la ruta responde el mismo 404 que para un id inventado.

El comentario quedó corregido con la medición adentro.

### Cómo se verificó

19 tests de integración corriendo **como `fastgram_app`**, y cada aserción de acceso cruzado
con su pareja: el bug que importa no es "devolvió lo que no era", es **"devolvió `null` y sin
embargo escribió"**. Un `update` cruzado que responde `null` mientras modifica la fila ajena se
ve idéntico a uno correcto desde el llamador, y la ruta lo traduce a un 404 impecable mientras
corrompe datos de otro workspace.

Verificados rompiendo tres cosas a propósito: el `setWhere`, el `deletedAt is null` del update
—sin él un PATCH resucita contenido borrado a medias— y el `in: []`.

## 2. Los 16 endpoints

Cuatro agentes en paralelo, propiedad disjunta de archivos. Lo que vale registrar:

**Concurrencia optimista antes que las demás guardas.** Un `PATCH /content/:id` con `revision`
vieja devuelve `409 stale_revision` **antes** de comprobar si la pieza es editable o tiene
posts vinculados. La razón: un cliente desactualizado puede estar equivocado también sobre por
qué no puede editar, así que el error útil es el que le dice que recargue.

**El lote de posts es todo-o-nada, y su status es siempre `400`.** Lo primero lo dice `NFR-011`
literal. Lo segundo es decisión: con `404` cuando todos los fallos son `not_found` y `409`
cuando son de estado, **el propio status diría qué ids existen en otro workspace**. El motivo
por id va en `details.failures`, que es donde el PRD lo pone.

**El filename del cliente no entra en la clave del objeto.** Es texto que elige quien sube: con
él dentro, un `../` o un `%00` viajan hasta el bucket.

**`GET /audio` exige `for`.** El PRD describe el catálogo como *"curado por tipo de
contenido"*, y el modal se abre siempre desde un formato concreto: una respuesta mezclada no
corresponde a ninguna pantalla.

### Lo que deliberadamente no está

**Ninguna de las rutas que cuesta `usage` cobra.** Falta el formato de `quota_ledgers.period`
—el schema lo marca PENDIENTE porque el reset es en el día ancla de facturación, no el 1 del
mes— y el `saveBucket` en `contents`. Cablearlo a medias cobraría un save que el camino de
reembolso no sabría devolver, que es exactamente el fallo silencioso que `FR-050` existe para
evitar.

`POST /blitz` se detiene en el gate con `503` **antes de escribir nada**, siguiendo §9.6: *"si
el sistema no puede comprobar el límite de forma segura, devuelve 503 (no 429)"*.

### Lo que la integración tuvo que deshacer

Tres agentes inventaron por separado **la misma clase local** para responder con códigos del
contrato que `DomainError` no tiene (`stale_revision`, `connection_ambiguous`). Cuando tres
implementaciones independientes llegan al mismo parche, lo que falta es la abstracción: ahora
está `ApiRejection` en `http/errors.ts`.

Su `publicDetails` es un campo **aparte** de `DomainError.details`, y tiene que serlo: ahí
viajan `attemptedBy` y `crossTenant`, que son precisamente lo que §9.2 no quiere publicar.
Reutilizar el campo convertiría una decisión de seguridad en un accidente de nombre. Hay un
test que se pone rojo si alguien los unifica.

Dos agentes escribieron una tabla de traducción de estados de reserva cada uno, porque mi
`canFinalize` decía `pending`/`completed` y la base dice `reserved`/`committed`. La traducción
funcionaba y era el síntoma; el arreglo fue alinear los nombres (ver §4).

Y `influencers.ts` importaba `reserveUpload` **desde `routes/v1/media.ts`** — una ruta
dependiendo de otra. Los agentes proponían moverlo a `http/uploads.ts`; habría roto una
separación que no podían ver desde su tajada, porque en esta app `http/` es política **sin
base** y `support/` es lo que la toca. Fue a `support/upload-reservations.ts`.

## 3. Lo que no funcionaba

### 3.1 Encolar dentro de la transacción de Drizzle

Es la razón entera de `ADR-005` —cola en Postgres en vez de Redis— y sólo se había probado
contra el ejecutor interno de pg-boss, que corre sobre `pg`. `packages/db` usa Drizzle sobre
postgres.js. Por esa vía fallaban **tres cosas distintas**:

1. pg-boss deja posiciones literalmente `undefined` en los parámetros de `insertJob` y las
   resuelve con `COALESCE`. `pg` manda `NULL`; **postgres.js tira `UNDEFINED_VALUE`** y ni
   llega a la base. Todo encolado transaccional moría en `provider_unavailable`.
2. `drizzle()` le reemplaza al cliente los serializadores de `jsonb` por la identidad, y el
   cliente es **compartido**. El `data` del job llegaba crudo al protocolo. Y no se puede
   autodetectar: el handle de la transacción es una función **sin `.options`**.
3. El puente por defecto no reconocía el handle de Drizzle, que es el que `core` propaga.

(1) se arregló adentro del adaptador. (2) y (3) son un puente **con nombre** que el cableado
elige a mano, `drizzleTransactionToExecutor`, porque elegir mal en silencio guardaría un string
JSON donde va un objeto o al revés.

El test que más vale es el que usa el puente **exportado** y no la copia local: sin él, lo
único probado sería el mecanismo, y el puente que importa el cableado entraría sin red.

### 3.2 `fastgram_app` no podía encolar

El encolado ocurre dentro de `withCompany(...)`, o sea con `SET LOCAL ROLE fastgram_app`.
pg-boss crea su esquema y sus tablas con el usuario de su pool, que es el dueño. Reproducido a
mano:

```
BEGIN; SET LOCAL ROLE fastgram_app;
INSERT INTO pgboss.job (...);
ERROR:  permission denied for schema pgboss
```

Las cuatro rutas que encolan fallaban en producción y andaban en desarrollo. **Tercera
aparición de la misma clase de bug** en el proyecto; quedó escrita como trampa 16 del general,
que es donde corresponde: ya no es un incidente, es un patrón.

La migración usa `ALTER DEFAULT PRIVILEGES` y no `GRANT ON ALL TABLES` por orden de ejecución:
Drizzle migra en el deploy y pg-boss crea sus tablas después, en otro proceso. Un grant sobre
"todas" no encontraría ninguna y **no fallaría** — no haría nada, que es peor.

### 3.3 Dos nombres para la misma cola

`core` encolaba en `build-content`, el catálogo del worker escuchaba `content-build`. El job
entra en una cola que nadie lee: el POST devuelve `201`, la pieza queda en `BUILDING` para
siempre y **nunca falla**, así que el save tampoco se reembolsa. No aparece en ningún log.

Ganó el catálogo —es la enumeración completa de los 21 y es lo que el consumidor escucha— y el
`build-content` del diagrama de IMPL §2.3 quedó corregido. Ahora los nombres salen de
`JOB_QUEUES` en `core` y hay un invariante de consistencia que detecta que el catálogo escriba
uno a mano.

## 4. Dos bugs de mi propio código anterior

**`canFinalize` fallaba abierto.** `ReservationStatus` decía `pending`/`completed` y la base
guarda `reserved`/`committed`. El tipo no lo atrapaba —las filas llegan del repositorio como
`string`— y un `committed` no matcheaba ninguna rama y caía en `proceed`: **segundo POST con el
mismo `uploadId`, segunda pieza, segundo cobro**.

Alinear los nombres no alcanzaba, y ésa es la mitad estructural del arreglo: mientras el caso
por defecto fuera `proceed`, cualquier estado no previsto volvería a permitirlo. Ahora el único
estado que sigue es el que dice que se puede seguir.

**`createBuildingContent` devolvía `revision: 0`** y `contents` tiene CHECK `revision >= 1`. El
dominio producía un valor que no se puede persistir; nadie lo había visto porque ninguna ruta
escribía contenido. El PRD no dice con cuánto arranca, así que decidió el CHECK que ya existía.
El argumento que acompañaba al 0 tampoco se sostenía: arrancando en 1, la pieza editada una vez
está en 2.

## 5. Las 37 aserciones que nunca habían corrido

`asr`, `media-renderer`, `payments`, `social-publisher` y `social-reader` tenían suite de
contrato y ningún adaptador. Con implementaciones en memoria, corren las 37 y pasan las 37 — y
la corrida encontró **cuatro casos que no medían lo que prometían**:

- **`fingerprint es puro` comparaba dos llamadas sobre la misma instancia.** Un renderer con un
  `randomUUID()` por instancia metido en el hash pasaba las diez aserciones de la suite: el
  cache de IMPL §5 no habría acertado nunca y nada lo habría dicho.
- Un caso llamado **"trae permalink"** que nunca miraba `permalink`.
- La aserción de idempotencia de facturación de `NFR-004` **no tenía ninguna aserción**.
- Una implicación al revés que hacía **imposible declarar el tier C** de adquisición.

Cinco de las 37 no pueden fallar contra un adaptador en memoria y están anotadas como tales:
contarlas como cobertura sin decirlo sería mentir por omisión.

## 6. Sobre trabajar con seis agentes a la vez

Funcionó otra vez, con la misma regla —propiedad disjunta de archivos, nadie toca
`package.json`, git, `tasks.md` ni `docs/**`— y ninguno pisó a otro.

**Lo que salió mal fue mío**: usé `git add -A` mientras los agentes escribían y me llevé
archivos suyos a medio escribir dentro de tres commits míos. Los deshice y volví a commitear
con rutas explícitas. La regla para la próxima está clara: **con agentes corriendo, nunca
`git add -A`**.

Lo que más valor dio de los reportes no fue lo que construyeron: fue la sección "qué quedó sin
verificar". Los tres bugs de §3 y los dos de §4 salieron de ahí, no del código entregado.
