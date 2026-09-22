# Sesión 2026-09-22 (3) — El documento mentía sobre 67 tareas

> **Lo más importante de esta sesión no es código.** Es que `tasks.md` —el
> documento que decide en qué se trabaja— sobreestimaba lo pendiente en 67
> tareas, y estuve a punto de despachar dos agentes a construir lo que ya
> existía.

## 1. Cómo apareció

Iba a despachar la tercera tanda leyendo `tasks.md`, que decía 276 pendientes.
Antes de escribir los enunciados miré el código de una de las secciones que iba
a tomar, y toda `P2-ANGLE` figuraba `[ ]` mientras
`apps/api/src/routes/v1/angles.ts` tenía **560 líneas** con los endpoints
implementados, las tres mutaciones reconciliando pesos dentro de la misma
transacción, y su test de integración.

Segundo caso, un minuto después: la nota de `P2-RENDER-002` decía que
«`services/render` todavía lo exige (`payload.ts`)» sobre el campo `audio`. Ese
archivo **no existe** —es `src/domain/payload.ts`— y ahí `audio` es opcional
desde `P2-RENDER-014`, que está `[x]` **tres líneas más abajo en el mismo
documento**.

Dos de las tres cosas que iba a despachar ya estaban hechas. Ahí paré de
despachar y mandé dos auditorías de sólo lectura.

## 2. Lo que encontraron

```
antes   99 hechas · 11 parciales · 276 pendientes · 1 bloqueada
ahora  145 hechas · 36 parciales · 206 pendientes · 1 bloqueada
```

**69 casillas corregidas.** Una va para atrás: `P2-RENDER-009` pasa de `[x]` a
`[~]`, porque la validación de que toda URL pertenece al workspace existe
**sólo** en `services/render` —que no está montado— y los dos puntos donde la
tarea la exige declaran por escrito que no la hacen.

El patrón es uniforme y vale nombrarlo:

> **Capa de dominio completa y bien testeada, sin una sola ruta HTTP ni UI
> encima.** Quien escribió el dominio marcó su parte; nadie marcó la tarea.

Se repite en P1-BRAND (11 tareas con dominio completo y cero rutas), P1-ONB,
P1-BRANDPG, P2-JV. El dominio de brand tiene defensa contra SSRF con tests de IP
decimal y el borde 172.32, y **no hay una sola ruta `/brand` en la API**.

### Las notas en prosa envejecen peor que las casillas

Cinco afirmaban cosas falsas. Además de la de `payload.ts`:

- `P1-QUEUE-005` decía «el replay nunca se ejerció de punta a punta». El test
  existe desde hace tandas y se llama, literalmente, *«idempotencia — el replay
  que nunca se había ejercido»*.
- `P1-QUOTA-011` daba por ausente el handler de `influencer-pipeline`, que
  devuelve los 250 créditos desde `058668e`, y describía como interino un cargo
  en `internal_refs` que la migración `0007` tipó con tres CHECKs.
- `P1-STORAGE-006` pedía un caso de uso que ya está escrito.
- `P1-UI-012` decía que faltaban `jsdom` y `@testing-library/react`.

**No se borraron.** Cada una quedó con qué decía y por qué cayó. Una nota que
desaparece sin rastro no enseña que las notas caducan.

### Mentiras de contrato, que son lo mismo con otro nombre

- `packages/contracts/src/openapi.ts` documenta `409 media_in_use` en
  `DELETE /media/:id`. La ruta devuelve 204 siempre. El código existe en el
  catálogo de errores, en el i18n y en la presentación — **en todas partes menos
  en la implementación**.
- El mismo archivo publica **cinco endpoints `/brand/*` que no existen**. El
  test de OpenAPI comprueba 27 paths y no incluye ninguno de ésos.
- La cabecera de `content.ts` dice «No consume el content save de `POST
  /content`». Es falso desde `P1-QUOTA-010`, y hay tests que lo prueban.

Ninguna está arreglada. Están reportadas en §8 del general.

## 3. El código de la tanda

### El adaptador estaba atrasado respecto de su propio servicio

`P2-RENDER-016` agregó `POST /probe`, `/normalize` y `/thumbnail` la tanda
pasada. El adaptador siguió lanzando `provider_unavailable` con el mensaje
*«services/render does not expose POST /probe»* para los tres, y su comentario
justificaba los stubs diciendo que «hoy no cuesta nada porque ninguno de los
tres se llama desde el pipeline de build».

Eso también era falso: `build-handler` llama a `thumbnail()` en **cada** build,
dentro de un `try/catch` que loguea y sigue. Montar el adaptador HTTP habría
dejado **todas** las piezas sin miniatura, con un warning por build y nada más.

Es la tercera vez en tres tandas que aparece lo mismo: **el punto de integración
entre dos agentes no lo verifica ninguno de los dos.**

### La autorización de media, y por qué va al lado del job

`services/render` no tiene base y no puede saber si una URL es del workspace 42.
Exige un grant HMAC y el puerto `MediaRenderer` no tenía campo para llevarlo.

`MediaAuthorization` viaja **al lado** de `RenderJob`, no adentro, y la razón no
es estética: `fingerprint(job)` hashea el job, y toda autorización lleva
vencimiento. Un `expiresAt` adentro haría que dos builds idénticos con diez
minutos de diferencia tengan fingerprints distintos, y el cache de IMPL §5
dejaría de acertar **nunca**. El síntoma sería una factura de CPU, no un error.

Es obligatoria y no opcional porque un render lee media del workspace: si se
pudiera omitir, olvidarla compilaría y fallaría en producción con un error de
proveedor opaco en **cada** build.

El puerto transporta intención; el adaptador, mecanismo. En el puerto no hay
firma, ni secreto, ni TTL.

### La duplicación que se mide en vez de razonarse

`media-grant.ts` replica `canonicalGrantBody` de `services/render` porque
`packages/adapters` no puede depender de `services/**`. Una clave en otro orden
da otro HMAC, y el servicio responde `media_grant_invalid`: un 400 que parece un
bug de permisos y es un bug de serialización.

Un test unitario contra una cadena escrita a mano sólo comprobaría que la copia
no cambió. Se midió contra el servicio real levantado en el 3102:

```
grant firmado por el adaptador  → 502 media_probe_failed   ← ACEPTADO
firma manipulada                → 400 media_grant_invalid
sin grant                       → 400 media_url_not_allowed
URL de otro workspace           → 400 media_url_not_allowed
grant vencido                   → 400 media_grant_invalid
```

El primero es la prueba: el grant pasó y el pedido falló **después**, buscando
la URL inexistente. El cuarto es `NFR-006` medido en vez de razonado.

### La cola de descubrimiento, y una guarda que no es la que parece

**Nada en todo el repo insertaba una fila en `suggestions`.** Por eso
`POST /blitz` daba siempre «cola vacía» y toda la sección P2-BLITZ quedaba sin
datos que mostrar.

`claimCreditsRefund` cierra su carrera con una sola sentencia, y funciona porque
es un `UPDATE`: con READ COMMITTED el segundo espera y **reevalúa** su `WHERE`.

Acá el trabajo es un `INSERT`, y **un `INSERT` no bloquea contra nada**. Dos
entregas toman su snapshot, las dos cuentan 0, las dos insertan 5, la cola queda
en 10. Escribirlo como una sola sentencia **no lo arregla**.

Así que hay dos piezas y conviene saber cuál sostiene qué:

1. El **advisory lock** por workspace **es la guarda**.
2. La **sentencia única** no agrega aislamiento. Agrega que el conteo y la
   inserción no se puedan escribir en transacciones distintas por descuido — la
   diferencia entre una invariante y una convención.

No es `SELECT … FOR UPDATE` sobre `blitz_preferences` porque `DATA-006`
sintetiza defaults sin fila: justo el workspace recién creado, el que más
necesita que le llenen la cola, no tiene fila que bloquear.

## 4. Las tres mediciones que salieron al revés de lo esperado

### Un test que medía `connect(2)`

El primer test de tres entregas concurrentes del refill **pasaba sin guarda**.
Una sonda con marcas de tiempo mostró que las tres no se solapaban:

```
A tx abierta  +2ms · A insertó 5, veía 0  +7ms
C tx abierta +10ms · B tx abierta +11ms
C insertó 0, veía 5 +12ms · B insertó 0, veía 5 +12ms
```

`postgres.js` conecta bajo demanda: la primera reusaba la conexión abierta y las
otras dos perdían ~8 ms montando el TCP. Con el pool caliente y la misma rotura,
la cola quedaba en **15**.

El test que sí mide la guarda no depende de ningún timing: `A` toma el lock,
inserta y **se queda con la transacción abierta**; `B` sólo puede terminar si el
lock no está.

### Una rotura deliberada que no rompía nada

Al verificar lo anterior rompí el advisory lock en `packages/db/src`, corrí los
23 tests y **quedaron verdes**. Iba a reportar que el agente se había
equivocado.

`apps/worker` resuelve `@fastgram/db` a su **`dist`**. Rompí código que no se
estaba ejecutando. Recompilando, el test determinista cae con el mensaje exacto
que el agente había reportado.

### Un barrido de 4×202 combinaciones que no encontró el bug

En el reparto de pesos de `/blitz/settings`, romper la rama de «todo lo que
queda vale 0» puso rojos dos tests elegidos a mano y **dejó verde el barrido**.

El motivo, medido: al bajar desde 100, el primer paso pide repartir 1 punto
entre tres y el reparto de restos lo acierta por casualidad; del paso siguiente
en adelante ya hay un peso distinto de 0 y la rama rota no se vuelve a tocar.

El comentario del test reclamaba una cobertura que no tenía. Ahora dice lo que
de verdad cubre.

## 5. Una aserción escondida detrás de otra, dos veces

Apareció en dos agentes distintos, en el mismo día, y es sutil:

Un test que quiere probar que algo **no** pasa, escrito con la aserción positiva
primero, falla por el motivo equivocado. El del banner de auto-guardado:

```
positiva primero → × Unable to find an element with the text: Saving…
negativa primero → × expected <span class="fgw-autosave__label"></span> to be null
```

Las dos son rojas, pero sólo la segunda **mide la mentira**. Con la primera, el
día que el banner diga `All changes saved` con una petición en vuelo, el test
fallará diciendo «no encontré Saving…», y quien lo lea va a buscar en el lugar
equivocado.

El otro caso: una aserción visible colocada **después** del contador de llamadas
de un mock, así que el test medía el mock y no la pantalla.

Los dos los encontró el propio agente rompiendo su código, no leyéndolo.

## 6. Decisiones que el PRD no cubre

- **`sharedPrefixes` va vacío** en `workspaceMediaAuthorization`. `FR-070` exige
  que el audio venga de la librería compartida y **en todo el repo no hay una
  sola pista de dónde vive** — ni clave, ni variable, ni endpoint. Inventar un
  prefijo autorizaría un origen que nadie eligió. Consecuencia concreta: con el
  adaptador montado, un `wall-of-text` con audio se rechaza.
- **El `DELETE` de contenido cuenta un post `CANCELLED`.** `FR-051` dice
  «cancelarlos no basta» para editar; el PRD no lo repite literal para borrar, y
  se resolvió por consistencia: la asimetría «cancelaste → podés borrar pero no
  editar» sería incomprensible.
- **Readiness degradado con 200 para storage y cola.** Un 503 por storage caído
  ascendería un fallo parcial a total: se cae para todas las réplicas a la vez.
  Postgres sí tumba la réplica, porque gobierna las ~30 rutas.
- **El auto-guardado reparte el presupuesto de forma uniforme** (20 s) en vez de
  un bucket de 3 fichas. Misma tasa, peor caso tres veces mejor.
- **`aiExplanation` se deriva de la selección, sin LLM.** El texto exacto no lo
  revisó nadie de producto.
- **El influencer se persiste sólo si hay un único candidato elegible.** Con
  varios, elegir es `DP-005`/`JV-6` y no hay adaptador de `Judgment`; resolverlo
  con `rng` sería sustituir un juicio semántico por un dado.

## 7. Estado medido al cierre

```
pnpm verify        18/18 · 0 violaciones (439 módulos · 1265 deps) · 19 invariantes · 1.772 unitarios
pnpm test:int      db 147 · api 140 (+11 salteados) · worker 86 · adapters 9 → 382
pnpm smoke:binary  9 checks, los dos binarios
tareas             145 hechas · 36 parciales · 206 pendientes · 1 bloqueada
colas con handler  5 de 21
cobertura web      45,72% de sentencias (antes no se podía medir)
```

## 8. Lo que no se hizo, y por qué

- **Las 42 fuentes.** 32 son de 10 familias OFL y se bajan; 10 son de
  `tiktok`/`snapchat` y esperan una decisión de licencia. Vendorizar binarios en
  el repo tiene implicaciones de atribución que decide una persona.
- **El render en `docker-compose`.** Necesitaría un Dockerfile con FFmpeg, y qué
  componentes lleva (GPL vs LGPL) es `P0-REPO-004`, **bloqueada**. Ponerlo igual
  sería fijar esa decisión de costado, en un archivo de compose.
- **Las mentiras de OpenAPI.** Implementar `409 media_in_use` o quitarlo del
  contrato es una decisión sobre qué promete la API pública.
- **Nadie abrió un navegador con las dos pantallas nuevas.** jsdom no pinta: no
  hay verificación del layout, del modo oscuro ni de los 375 px.
