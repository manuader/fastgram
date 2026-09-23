# Sesión 2026-09-23 — Sexta tanda: las escrituras llegan, las fuentes pueden salir de `pending`

Ocho agentes en tres oleadas, doce commits (`8b20235`…`2687ba9`). El hilo: las dos cosas que la
tanda anterior dejó escritas como «esto deja media app muerta» —el proxy sólo-`GET` y el
handler de `brand-source-analysis` que no se podía montar sin mentir— tienen ahora código que
las destraba. **Ninguna de las dos se probó de punta a punta**: no hubo navegador, ni LLM real,
ni pg-boss real. Eso está abajo, en su sección.

## Lo que costó tiempo y no se deduce del código

### 1. La clave del re-análisis era fija sin parecerlo

`POST /brand/sources/:id/reanalyse` encolaba con `singletonKey: brand-source:<id>:<analysisCount>`.
El comentario explicaba bien por qué la clave no podía ser sólo el id (trampa 39). Lo que no
vio: **el contador vuelve a 1 al vencer la ventana**. Así que el segundo re-análisis de otro día
repetía `:1`, pg-boss lo deduplicaba contra el job viejo, y la API respondía **202** con la
fuente en `analyzing` — sin ningún job que la analizara. La API no miraba `created`.

Peor todavía: `analysis_window_started_at` no existe como columna, así que en la práctica
`windowStart` es siempre `undefined` y el contador **siempre** vuelve a 1. La clave era `:1` en
cada re-análisis de la vida de la fuente.

Mientras nada consumía la cola no se notaba. Lo vio el agente que escribió el consumidor. El
test que lo reproduce da `1` job donde tendría que haber `2`. La clave ahora lleva el instante.
Lo que **no** cierra, y está escrito junto al arreglo: `findById` no toma lock, así que dos
pedidos simultáneos pueden encolar dos análisis. Es un análisis de más, no una fuente colgada.

### 2. «Qué colas se montan» no es «con qué se montan»

`media-normalization` se monta con **su propia** instancia de `HttpMediaRenderer`, separada de
la de `content-build`, que sigue en memoria. Esa separación existe por una sola razón: el
renderer de memoria marcaría `failed` cada video real. Los tests de `handlers.test.ts` miraban
qué colas quedaban montadas según la configuración. Pasarle a la normalización
`deps.renderer` en vez de `deps.normalizationRenderer` —un cambio de una línea, exactamente el
fallo que el diseño previene— **dejaba los 66 tests en verde**. Hay un test de cableado nuevo
que la atraviesa con un renderer trampa y ése sí cae.

### 3. `expect.unreachable` dentro de un `try` se atrapa a sí mismo

El agente de la normalización lo encontró en su propio test: «el mensaje no incluye el secreto»
pasaba **sin que nada lanzara**, porque `expect.unreachable(...)` estaba dentro del `try` y su
error lo atrapaba el `catch` del mismo test, que después comparaba el mensaje de *ese* error.
Sólo lo vio al quitar la guarda y ver que seguía verde.

### 4. Un handle que da de alta la cuenta equivocada

El bug reportado era LinkedIn: `(linkedin, "acme")` armaba `linkedin.com/acme`, que el propio
detector no reconoce. Al poner una guarda de ida y vuelta —el handle arma una URL, la URL se
vuelve a detectar, y tiene que dar lo mismo— apareció uno peor: `(youtube, "user/acme")` armaba
`youtube.com/@user/acme` y el detector resolvía **`@user`**: el alta salía 202 con **otro
canal**. La guarda queda aunque `core` ya arme bien LinkedIn.

### 5. El prefiltro y el extractor no coincidían

El extractor `website` clasifica las IPs **después** del DNS. Midiendo contra el `dist` de `core`,
su autor vio que el prefiltro de entrada (`assertHostAllowed`) dejaba pasar multicast y 240/4.
No era explotable —el extractor los corta igual—, pero dos definiciones de «IP bloqueada» que
no coinciden son la próxima divergencia.

## Decisiones que el PRD no cubre

- **Tier del extractor `website`: B.** FR-011.4 nombra OpenGraph en B; C es la página
  *renderizada* y esto no ejecuta JS. En contra: D-01 dice «fetch público (tras OQ-16)». Si se
  decide C, es una línea — y falta `robots.txt`.
- **Fuentes sociales sin extractor → `failed` + `unsupported_platform` + `D_assisted`.** Es
  literal: esta instalación no lee esa plataforma. `provider_unavailable` culpaba a la
  plataforma, que es por qué la tanda anterior no montó el handler.
- **Fallo del LLM → `failed` con motivo `null`.** Ningún motivo del enum lo describe sin mentir.
- **Ningún número de los que el PRD no da tiene default:** timeouts, tamaños, puertos y días de
  retención del extractor y del snapshot son variables obligatorias. Sin ellas la cola no se
  monta y el arranque dice qué falta.
- **Purga de snapshots:** `profile_signals` → NULL, `content_items` → `[]`; `derived_fields` y
  `conflicts` sobreviven. `conflicts` es la discutible: no borrar es reversible.
- **Anti-CSRF:** el origin propio sale de `FASTGRAM_APP_ORIGIN`; `nextUrl.origin` detrás de un
  proxy es la dirección interna, y `X-Forwarded-Host` se ignora a propósito.

## Lo que quedó sin verificar

- **Ningún navegador** vio el onboarding, el calendario ni una escritura por el proxy.
- **Ningún LLM real** recibió el prompt de síntesis; el esquema estricto no se probó contra un
  gateway.
- **Ningún handler nuevo pasó por pg-boss real.** Sólo `media-normalization` corrió contra
  `services/render` real, a mano, fuera del worker.
- **HTTPS real** en el extractor (SNI con IP fijada) sin probar.
- **Divergencia fijada, no decidida:** `SubscriptionStatus` del puerto tiene `incomplete`, que
  DATA-002 y Postgres no tienen.

---

## Séptima tanda (misma fecha)

Tres agentes más, cuatro commits (`36ab90c`…`a7a7f3e`).

### El save regalado

`bumpAndRebuild` encolaba las ediciones con `enqueueBuild`, en `content-build`, porque el render
es el mismo. Pero la cola también decide **cómo se cierra un fallo**, y la de build hace `FAILED`
+ reembolso. La pieza editada conserva el `saveBucket` del build original, que sí se entregó: cada
edición fallida devolvía un save y mataba una pieza que PRD:1204 dice que sigue usable. Nunca se
vio porque ningún productor real crea piezas editables (el accept de Blitz no está cableado).

`content-rebuild` usa el mismo motor con otro cierre: vuelve a `CREATED` con los archivos
anteriores y `lastEdit` fallido, sin tocar la cuota. Los jobs de edición que queden en la cola
vieja se cierran como rebuild.

**Ninguna edición llega al video.** El render lee sólo `buildPayload`; `PATCH` escribe
`content_text_boxes`. El mapeo de las cajas del editor (0–100) a píxeles no está en el PRD, así que
una pieza con cajas cierra el rebuild con `edit_not_renderable` sin llamar al renderer, en vez de
rehacer la misma pieza y decir que la edición se aplicó.

### El mensaje del proveedor salía por la API

`failBuild` escribía `failure.reason` en `lastEdit.failureReason`, y `lastEdit` sale tal cual por
`toContent`: `"bad_request: <mensaje del motor>"`. Los tests afirmaban ese texto. Ahora va el
código; el mensaje queda en el log.

### Lo que no se construyó, a propósito

- **`GET /posts?from&to`.** §9.3 (PRD:2292) no lista parámetros; §12 (PRD:2729) documenta sólo
  `status`. Propuesta para el PRD: `[from, to)` en UTC, fecha efectiva
  `coalesce(posted_at, scheduled_at_utc)`, orden ascendente con cursor que codifique el modo,
  índice por expresión, y —para el criterio (1) de FR-110— un `GET /posts/counts?from&to`.
- **Tier D asistido.** `POST /brand/sources` rechaza `manual` y §9.14 no trae ruta para pegar la
  bio o subir capturas. El copy de `unsupported_platform` se corrigió para no prometerlo.

### Carreras cerradas

Dos lecturas sin lock que precedían a una decisión: el re-análisis de brand (`lockBrandSource`) y
`PATCH`/`regenerate` de contenido (`lockContent`). El test del re-análisis tuvo que avanzar el
reloj entre los dos pedidos: con el mismo milisegundo la clave coincidía, el doble de la cola los
juntaba y el test veía un job **también sin lock** — medía la deduplicación, no la guarda.

---

## Identidad (misma fecha, con permiso para instalar `better-auth`)

- **Dependencias:** `better-auth@1.7.5` y `pg@8.23.0` (la versión que ya traía pg-boss). El
  adaptador de Drizzle de Better Auth pide `drizzle-orm` ≥0.45.2 y el repo está en 0.38.4: se usa
  el `Pool` de `pg`, que Better Auth acepta directo, en vez de subir Drizzle. `pg` quedó también
  como dependencia directa de `apps/api`: el agente lo había resuelto con `createRequire` a
  través de `adapters`, que escondía la dependencia a pnpm y a depcruise.
- **Diseño (no está en el PRD):** la web es BFF. La API emite el token sólo al servidor web; el
  navegador lo tiene en `fg_session` (`HttpOnly`); el proxy lo reenvía en `X-Fastgram-Session` y
  ninguna otra credencial. `/api/fastgram/v1/auth/*` da 404 en el proxy: si no, le pasaba el
  token al JavaScript de la página.
- **`FORCE RLS` otra vez (trampa 13, del lado del usuario):** `fastgram_app` no ve
  `workspace_memberships` sin GUC, y el GUC es justo lo que se está tratando de averiguar. Toda
  sesión quedaba sin workspace. `0012` agrega `app.resolve_session_workspace`, `SECURITY DEFINER`.
- **Rate limit por IP sólo con `AUTH_TRUSTED_PROXIES`:** detrás del BFF, la IP del socket es la
  de la web, y un bucket por IP sería un límite global para todo el producto.
- **`.env.example` estaba roto antes de esto:** `FASTGRAM_API_URL` sin `/api/v1` hacía que cada
  llamada de la web pegara fuera del prefijo.
- **Verificado a mano con la API y la web levantadas**, secreto efímero generado en el momento y
  no escrito en ningún lado. Los datos de prueba se borraron después. El formulario de `/login`
  **no** se llenó desde el navegador.
