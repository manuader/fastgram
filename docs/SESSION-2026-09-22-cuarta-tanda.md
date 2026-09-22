# Sesión 2026-09-22 (4) — Lo que un test verde no dice

> Cuatro agentes y el coordinador. El hilo de la tanda: **seis roturas
> deliberadas**, y las tres que más enseñaron son las que **no** salieron como
> se esperaba.

## 1. Una línea que sostiene el aislamiento de todo el modelo, con un test

`createCompanyScopedRepository` produce los 28 repositorios del proyecto. El
aislamiento por workspace de todos ellos descansa en el
`eq(config.companyId, scope.companyId)` de `scoped()`.

Sacándola y corriendo la suite entera de `packages/db`:

```
Tests  1 failed | 135 passed | 24 skipped (160)
```

**Un solo rojo.** `repositories-write.int.test.ts` —19 tests escritos
justamente para el acceso cruzado— no se enteró, y `rls.int.test.ts` tampoco.

La razón es la trampa 21 a escala: con el GUC puesto, **RLS tapa el agujero** y
el `WHERE` del repositorio nunca se ejerce. Los dos resultados se ven idénticos
desde el llamador.

El archivo que faltaba (`tenant-filter.int.test.ts`) corre **sin `SET ROLE` y
sin GUC**. Es deliberadamente menos realista que `repositories-write`, y por eso
mide lo que aquél no puede. Con la línea sacada: **7 rojos**, cubriendo
`findById`, `list`, `listByPage`, `count`, `update`, `softDelete` y
`hardDelete`.

Cada aserción de escritura viene con una segunda que relee la fila víctima: el
bug caro no es «devolvió lo que no era», es **«respondió que no y sin embargo
escribió»** — un 404 impecable mientras corrompe datos de otro workspace.

## 2. Las fuentes: bajarlas no era el problema

El bloqueo #1 de `P2-RENDER-015` parecía ser conseguir 32 archivos OFL. Se
escribió el script, bajó los 32 con licencia y procedencia, y después se probó
contra el motor:

```
0 familias resuelven · 12 fallan
```

Los archivos estaban, eran TTF válidos y sus nombres internos eran correctos
—`Montserrat`, `Anton`, `Bebas Neue`, leídos de la tabla `name`—. El motor
seguía sin tomarlos.

La causa era una **conclusión falsa documentada en el propio cargador**. Decía:
*«lo que SÍ funciona es pasar el archivo con `fontfile` (verificado con
Georgia.ttf: 545x40 contra 517x39 del fallback)»*. Georgia es una fuente **del
sistema** en macOS. Aquel experimento comparó «una familia que existe» contra
«una que no», no «con archivo» contra «sin archivo».

Aislado:

```
centinela __NoSuchFamily__            517x39
Georgia SIN fontfile                  545x40   ← resuelve sola
Georgia CON fontfile                  545x40   ← igual
Anton CON su propio fontfile          517x39   ← NO carga
Anton CON el fontfile de Georgia      517x39   ← el archivo se ignora
```

La última línea cierra el caso: pedir «Anton» pasándole el archivo de Georgia da
exactamente el centinela. **`fontfile` no se usa.**

Así que el bloqueo no se cierra bajando archivos: queda partido en conseguirlos
(hecho) e **instalarlos donde el sistema los encuentre por nombre**, que es
trabajo del Dockerfile que `P0-REPO-004` bloquea.

**Lo que sí se sostiene del diseño original es la sonda centinela**, que es lo
que delató todo esto. La conclusión fácil habría sido «ya están, listo».

### Y una trampa de camino

El primer intento de descarga usó un user-agent de MSIE 6 razonando que «un UA
viejo da ttf». La API lo tomó al pie de la letra y devolvió **EOT** —el formato
de Internet Explorer 6— por una URL sin extensión, con `content-type:
text/html`, pesando 130 KB y con toda la pinta de una fuente.

Lo delató la firma: `04fe0100`, que es el **tamaño del archivo en
little-endian** — la cabecera de un EOT. Sin comprobar bytes mágicos habrían
quedado 32 archivos en disco y el script habría salido en verde.

## 3. Tres roturas que no salieron como se esperaba

### La que dio el resultado tranquilizador

Al verificar la guarda del refill de descubrimiento, se rompió el advisory lock
en `packages/db/src`, se corrieron los 23 tests y **quedaron verdes**. Estaba a
punto de reportarse que el agente se había equivocado.

`apps/worker` resuelve `@fastgram/db` a su **`dist`**. La rotura no se estaba
ejecutando. Recompilando, el test determinista cae con el mensaje exacto que el
agente había reportado.

Es la más peligrosa de las trampas nuevas porque **«lo rompí y no pasó nada» se
lee como «la guarda es inútil»**, y las dos conclusiones eran falsas.

### La que reveló que la guarda era casi redundante

En el alta de brand sources se borró el pre-chequeo del duplicado dentro del
propio workspace: **40 tests verdes**. El índice global atrapa el duplicado
igual y produce la respuesta idéntica.

Casi. Con el workspace **en el cap de 5**, sin pre-chequeo `createBrandSource`
evalúa `ERR-B10` antes del `INSERT` y le dice al usuario «borrá una fuente»
sobre una fuente que **ya tiene** — un consejo falso.

La respuesta correcta no era borrar la guarda ni dejarla sin test: era
**encontrar el caso que la distingue**, escribirlo, y volver a romper:

```
× con el workspace en el cap, re-añadir una fuente propia dice 409, no
  'te pasaste de 5'   → expected 400 to be 409
```

### La que fallaba por el motivo equivocado

En la status page, una rotura ponía tres tests en rojo con el mensaje *«Unable
to find role="alert"»* — aunque la aserción negativa estaba escrita primero.

La causa: el **`await` de espera** era positivo (`findByRole("alert")`). Espera
por lo correcto, así que falla antes de llegar a la negativa. Se arregló
esperando una señal verdadera en los dos mundos —que se apague el `aria-busy`—
y afirmando después.

**La aserción negativa primero no alcanza si el `await` de arriba es positivo.**

## 4. Lo que se construyó

**El mensaje de la cola dejó de mentir.** `POST /blitz` con la cola vacía
respondía *«the queue replenishes in the background»* y nada la reponía. El
catálogo marca con `scheduled` los jobs por reloj y éste no lo tiene, así que no
hubo que elegir: es por evento, y el PRD lo nombra tres veces.

La parte sutil es la clave: el adaptador deriva de `singletonKey` un **id
determinista y permanente**, así que una clave fija por workspace encolaría el
refill **una sola vez en la vida**. Va con cubo por minuto.

**Ninguna brand source envejecía nunca.** El circuito de la omisión: sin
handler, `main.ts` no programa el cron —a propósito— así que la cola no existía
y el barrido no corría. El `SECURITY DEFINER` está medido: sin él, con
`fastgram_app` y sin GUC el `UPDATE` afecta **cero filas y sin error**.

**Nueve rutas de brand** sobre un dominio que llevaba tandas sin poder
alcanzarse, más un test que compara el OpenAPI contra las rutas que Fastify
**registra de verdad**, en los dos sentidos. En su primera corrida encontró una
tercera mentira que nadie había pedido buscar: `GET /blitz/angles/page` existía
y el contrato no la nombraba.

**El `JudgmentSink` contra la base**, con la guarda en tres capas — y la tercera
(que el sink abra su propia transacción) se justificó con una predicción que
salió mal: `postgres.js` rechaza la transacción entera con el error original, así
que el `.catch()` del llamador no salva nada.

**La tab `My Posts` y la status page**, que redacta **en el servidor** porque no
renderizar no es no publicar: el JSON entero seguiría en la pestaña de red.

## 5. Decisiones que el PRD no cubre

- **El choque de unicidad no dice con quién chocaste.** El literal de `ERR-B06`
  convierte el alta en un buscador de clientes: probás `@nike`, leés «otro
  workspace», sabés que Nike es cliente. Se devuelve la forma neutra que el
  propio PRD eligió para el caso equivalente de la rama web, y el cuerpo es byte
  a byte idéntico en los dos choques. El copy de `packages/ui` se alineó: si la
  UI renderizara por código, el filtrado volvía por ahí.
- **La status page no nombra dependencias.** Es pública; publicar `checks` le
  dice a cualquiera qué subsistema está débil durante un incidente.
- **`sharedPrefixes` va vacío** en la autorización de media: no hay una sola
  pista en el repo de dónde vive la librería compartida de audio.
- **El payload del barrido se ignora.** Uno que aceptara `companyId` dejaría de
  ser global: quien pudiera encolar elegiría a quién le envejecen las fuentes.

## 6. Estado medido al cierre

```
pnpm verify        18/18 · 0 violaciones (462 módulos · 1402 deps) · 19 invariantes · 1.837 unitarios
pnpm test:int      db 177 · api 188 (+11 salteados) · worker 86 · adapters 9 → 460
pnpm smoke:binary  9 checks, los dos binarios
tareas             149 hechas · 41 parciales · 197 pendientes · 1 bloqueada
colas con handler  6 de 21, y la primera que corre sola cada noche
```

## 7. Lo que sigue abierto

- **Nada encola `brand-source-analysis`.** Las rutas de brand encolan con un
  payload que **nadie consume**, así que ninguna fuente sale nunca de `pending`
  — y por eso el cooldown de re-análisis no se ejercita en producción.
- **Los enums del tier C no coinciden** entre `ports`/`core` y `db`/`contracts`.
  No explota hoy porque el tier está apagado.
- **`apps/worker` no expone ninguna sonda.** Un worker con la base caída no lo
  dice en ningún lado.
- **Nadie abrió un navegador** con las cuatro pantallas nuevas. jsdom no pinta.
