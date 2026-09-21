# 2026-09-21 — El worker consume `content-build`

## Qué estaba roto, exactamente

`POST /content` creaba la pieza, **cobraba el content save** y encolaba el build,
todo en la misma transacción. `apps/worker/src/main.ts` era esto entero:

```ts
console.log("[worker] sin handlers todavía — ver tasks.md P1-QUEUE");
```

O sea: la pieza nacía en `BUILDING` y se quedaba ahí **para siempre**. Y desde
que la cuota se cableó, eso cuesta plata: el save se descuenta al crear, y el
camino de reembolso de `FR-050` estaba escrito pero **nadie lo llamaba**, porque
quien tiene que llamarlo es el handler del job que falla.

No fallaba nada. No había log de error, no había alerta, no había 500. Es el
peor modo de falla que tiene este sistema.

## La forma: leer corto, trabajar largo, escribir corto

```
  [tx 1]  bloquear la fila, leer buildPayload            ~ms
          render + subida a storage                      30 s – 2 min
  [tx 2]  bloquear otra vez, comprobar, escribir         ~ms
```

El render **no** puede ocurrir dentro de una transacción. `NFR-001` acota un
build a 30 s – 2 min: una transacción abierta ese tiempo mantiene la fila
bloqueada contra el `PATCH` del usuario, retiene una conexión del pool por cada
build en vuelo y, si el proceso se cae, deja la transacción colgada. Con
`NFR-025` hablando de 10 builds por minuto, eso es el pool entero.

**El precio de partirlo en dos es que entre medio el mundo se mueve**, y de ahí
sale casi todo lo demás que hace el handler. Vale la pena tenerlo presente al
escribir el resto de los 20 handlers: no es una particularidad de éste.

## Las cinco cosas que encontré escribiéndolo

### 1 · Dos payloads en la misma cola, y ningún consumidor que los reconociera

`core/content/accept-blitz-suggestion.ts` encolaba `ContentBuildJob`, que exige
`suggestionId` y un `BlitzContentType`. `apps/api/routes/v1/content.ts` encolaba
su propio `ContentBuildRequest`, con `reason`, `prompt`, y un `contentType` que
incluye `custom` —que no es tipo de Blitz— y sin `suggestionId`, porque no hay
sugerencia. El archivo de la ruta lo dejó anotado: *"Queda reportado para que
quien escriba el worker lo cierre"*.

Unificado en `packages/core/src/jobs/content-build.ts`, con un núcleo
obligatorio de cuatro campos (`companyId`, `contentId`, `contentType`,
`revision`) y el resto opcional. No es una unión discriminada a propósito: una
unión obligaría a cada productor futuro a declararse, y el efecto de no
declararse bien sería que el job se rechaza en vez de construirse.

**El parser está escrito a mano** porque `core` no puede importar npm
(`core-no-npm`), y eso está bien: el parseo **no es opcional**. El payload
vuelve de la cola como `unknown` —viajó por JSON en una tabla de Postgres— y un
`as` sobre eso es una mentira que el compilador no puede desmentir. Un
`contentId` que en realidad es `undefined` termina en un `WHERE id = 'undefined'`,
que **no falla**: no encuentra nada, y el handler concluye que la pieza se borró.

### 2 · `audio` era obligatorio en el puerto y el PRD dice lo contrario

`WallOfTextJob` y `VideoHookJob` pedían `audio: RenderAudio`. `FR-053.1`
(PRD:1234) dice que elegir *No audio* omite el bloque entero, y
`contentBuildPayloadSchema` ya lo tenía opcional.

Resultado: **una pieza perfectamente válida creada por `POST /content` no se
podía ni escribir como `RenderJob`** — y es el payload que la propia suite de
cuota de `apps/api` usa en todos sus casos. Gana el PRD; el puerto ahora lo tiene
opcional.

**`services/render` todavía lo exige** (`domain/payload.ts`, `audio: audioRefSchema`
sin `.optional()`). Hoy no rompe nada porque el adaptador real no existe. El día
que exista, se topa con esto de entrada.

### 3 · `JobContext` no decía cuántos intentos quedan

El handler tiene que hacer algo distinto en el último intento: un fallo
transitorio se relanza para que la cola reintente con su backoff, pero **si se
relanza también el último**, la pieza se queda en `BUILDING` cuando la cola se
rinde — que es exactamente el estado colgado que esta tarea vino a cerrar, sólo
que ahora con un save cobrado.

El puerto daba `attempt` y no el tope. La alternativa era que el consumidor
reescribiera el `retryLimit` que eligió el productor, que es la clase de
constante duplicada que se separa en silencio. Se agregó `maxAttempts` a
`JobContext`; el adaptador lo saca de `retryLimit` de la metadata de pg-boss
(reintentos + 1 = intentos).

Y como red, un invariante nuevo en `check-consistency.mjs` compara el
`retryLimit` de la ruta contra el `maxAttempts` del catálogo del worker.

### 4 · El log de "colas sin handler" mentía

`main.ts` reporta al arrancar qué colas **no** tienen consumidor. Tenía la lista
de las que sí escrita dos veces —una en `queue.work(...)` y otra en un `Set`—,
así que apuntando el `work()` a otra cola el log seguía diciendo que
`content-build` tenía handler.

Lo encontré rompiendo la cola a propósito para verificar el smoke. Ahora hay un
único mapa `HANDLERS` del que salen las dos cosas. Un reporte de arranque que
miente sobre esto es peor que no tenerlo: es exactamente donde uno va a mirar
cuando una pieza se quede en `BUILDING`.

### 5 · Dos de mis tests pasaban por la razón equivocada

Esto es la parte que más vale del archivo, porque los dos se veían verdes.

**El de doble reembolso.** Escribí "reejecutar el handler no devuelve el save dos
veces", corrió verde, y después **quité la guarda de `saveRefundedAt`** y siguió
verde. Lo que frena el segundo reembolso no es la guarda: es el chequeo de
**estado**, que ve la pieza en `FAILED` y ni siquiera llega al reembolso. La
guarda está detrás de eso y hoy el handler no puede alcanzarla —marca `FAILED` y
escribe `saveRefundedAt` en la misma transacción—, así que ahora tiene su propio
test con el estado sembrado a mano, y ése sí se pone rojo.

**El de `revision`.** Cubría el caso "llega un job viejo", donde la revisión ya
difiere **antes** del render. La carrera que de verdad importa es la otra: la
edición que entra **durante** el render, entre la transacción que lee y la que
escribe. Quitar el chequeo de `revision` del `commit()` no ponía nada en rojo.

La única forma de provocarla es desde el renderer inyectado: se le pasa un
callback que corre dentro de `render()` y hace el `UPDATE`. Simularla con
`Promise.all` desde afuera no la reproduce, porque las dos transacciones del
handler son cortas y se ordenarían solas.

## Verificación

Siete mecanismos, cada uno roto a mano hasta ver el test en rojo:

| Mecanismo | Test que se pone rojo |
|---|---|
| guarda de doble reembolso (`saveRefundedAt`) | `una pieza que ya tiene saveRefundedAt no se vuelve a reembolsar` |
| `revision` al **leer** | `un job viejo no pisa una revisión más nueva` |
| `revision` al **escribir** | `una edición que entra DURANTE el render descarta el resultado` |
| `revision` al **fallar** | `y si además el render falla, NO marca FAILED ni devuelve el save` |
| corte del último intento | `en el ÚLTIMO intento no se relanza: se cierra y se devuelve el save` |
| `FOR UPDATE` de `lockContent` | `dos transacciones no deciden sobre la misma fila a la vez` (→ *expected 2 to be 3*) |
| filtro de soft-delete | `no devuelve una pieza borrada` |

El del `FOR UPDATE` vive en `packages/db` y no en el worker, y por la misma razón
que el de `quotaLedgerStore`: los tests del handler no lo pueden medir, porque
sus dos transacciones son cortas y se ordenarían solas aunque no hubiera lock.
Medirlo exige meter una pausa **dentro** de la transacción, y eso sólo se puede
donde uno escribe el cuerpo de la transacción.

Y el smoke del binario:

```
pnpm verify                                # 18/18 · 0 violaciones · 18 invariantes · 1.455 unitarios
pnpm test:int                              # db 99 · api 67 · worker 21 → 187
pnpm --filter @fastgram/adapters test:int  # 9
pnpm build && pnpm smoke:binary            # 9 checks
```

`pnpm smoke:binary` levanta ahora **los dos procesos** y espera a que la pieza
llegue a `CREATED`. Encolar sin consumir no es un circuito: el nombre de la cola,
la forma del payload y los permisos del rol sobre el esquema de `pgboss` sólo se
verifican con los dos hablando entre sí. Verificado rompiéndolo: con el `work()`
apuntando a otra cola, el smoke se pone rojo con el estado real a la vista.

## Dónde quedó cada cosa, y por qué ahí

`refundContentSave` se mudó de `apps/api/src/support/quota.ts` a
`apps/worker/src/support/quota.ts`, y **se borró del lado de la API**. El criterio:
la API cobra y no reembolsa nunca; el worker reembolsa y no cobra nunca. Cada app
se queda con la mitad que de verdad ejecuta, y así no hay dos copias de la regla
que decide **a qué bucket** vuelve el save — que es la parte cara de equivocarse,
porque los tres tienen precio distinto y el error no tiene síntoma.

Lo que sí era común subió:

- `asPlanId` → `core/quota/plans.ts` como `parsePlanId`. Las dos apps lo
  necesitan y un default distinto de cada lado es un descuadre de facturación.
- `canonicalObjectUrl` → `packages/adapters`. Es una función pura sobre el
  puerto `Storage`, y la copia del worker habría sido la segunda definición de
  *qué es la dirección de un objeto*: las dos seguirían devolviendo una URL
  plausible.
- `lockContent` → `packages/db/src/repositories/content-build.ts`, porque es SQL
  y `apps/worker` no puede importar `drizzle-orm` — no es alcanzable a propósito,
  igual que en `apps/api`.

Ese último punto es el que conviene no perder: **no hay ningún paquete que
dependa de `core` y de `db` a la vez.** No existe una capa de casos de uso
compartida entre apps. Cada vez que algo necesite las dos, la respuesta va a ser
una de estas tres: partirlo por app (como el cobro y el reembolso), subir la
parte pura a `core`, o bajar la parte SQL a `db`. Si aparece algo que no entra en
ninguna, ahí sí hay que decidir si el monorepo necesita ese paquete — y es una
decisión de IMPL §2.2, no de una tarea.

## Lo que este handler NO hace

- **`custom`.** Las piezas de `POST /content/custom/video` no tienen
  `buildPayload` —el archivo ya está subido— y **tampoco tienen forma de
  encontrar su archivo**: la reserva de subida no deja la `storageKey` en la fila
  del contenido. Su build es normalización + thumbnail (§9.5 #7), no un render.
  Se marcan `FAILED` con un motivo explícito. No cobran save, así que no hay nada
  que devolver, y es mejor que dejarlas colgadas: al menos se ve.
- **`prompt` / `mentionBusiness`.** `AI-004` los usa para regenerar copy con un
  modelo antes de construir. No hay puerto `Llm` cableado acá; el payload los
  trae y el handler los ignora, que es mejor que fingir que los aplica.
- **El render de verdad.** Monta `MemoryMediaRenderer`: el artefacto son bytes
  sintéticos derivados del fingerprint. Lo que corre de punta a punta es el
  **pipeline**, que es lo que no existía; el render ya está probado del otro lado
  con 119 tests y sus golden files.
