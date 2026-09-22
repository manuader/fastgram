# 2026-09-22 — Cuatro agentes en paralelo, y el bug que apareció al verificarlos

Cuatro tandas simultáneas, cuatro directorios disjuntos. Lo que sigue no es el
detalle de cada una —está en los commits— sino las cinco cosas que costaron
tiempo y no se deducen del código.

## 1 · El contrato entre dos agentes hay que fijarlo antes, no después

A trabajaba en `services/render` y B escribía el adaptador HTTP contra ese
mismo servicio, al mismo tiempo. Es el único punto donde se tocaban, y es
exactamente donde este proyecto ya se lastimó tres veces: dos procesos, dos
mitades de una interfaz, cada uno inventando la suya.

Lo que hice fue escribir el contrato en los dos prompts antes de despachar:

> `POST /render` gana, por artefacto, un campo `href`: un path **opaco** elegido
> por el servidor. B no parsea nada de él — lo concatena al base URL y lo pide
> tal cual. El esquema de claves es de A y puede cambiar sin tocar al cliente.

Funcionó: el `href` que emite A y el que consume B encajaron sin una ronda de
corrección. Pero la parte que **no** funcionó es más interesante, y está abajo.

## 2 · Un reporte de agente puede estar correcto y obsoleto a la vez

El reporte de B decía, como bloqueo de producto número uno:

> `audio` obligatorio en `wallOfTextPayloadSchema` y `videoHookPayloadSchema`.
> **Hoy una pieza válida sin audio falla con `bad_request`.**

Era verdad cuando B lo leyó. **Y ya era falso cuando lo escribió**: A hizo
`audio` opcional mientras B trabajaba. Ninguno de los dos podía saberlo, y
ninguno de los dos podía verificar la integración —A no tenía el adaptador, B
tenía una lectura vieja del servicio.

Eso es trabajo del coordinador y no es opcional. Levanté los dos y rendericé a
través del adaptador:

```
sin-audio       -> OK video/mp4 56573  bajados: 56573  coinciden: true
con-audio       -> OK video/mp4 87549  bajados: 87549  coinciden: true
hook-sin-audio  -> OK video/mp4 56573  bajados: 56573  coinciden: true

ffprobe sin-audio  ->  h264,video              (un solo stream)
ffprobe con-audio  ->  h264,video  aac,audio
```

**La lección operativa:** con agentes en paralelo, el punto de integración no lo
verifica ninguno de los dos lados. Hay que medirlo al final, con los dos en su
estado definitivo, o el sistema queda con dos mitades que cada una cree que la
otra está rota.

Y de paso apareció un detalle de configuración que no estaba en ningún reporte:
sin `RENDER_ALLOWED_MEDIA_PREFIXES`, el servicio rechaza **toda** URL con
`media_url_not_allowed / sin_politica_configurada`. Es `P2-RENDER-009`
funcionando, pero desde el adaptador se ve como un `bad_request` opaco y cuesta
media hora entender que no es el mapeo.

## 3 · Programar un post devolvía 500, siempre

Esto apareció verificando a C, no haciendo una tarea.

`posts.ts` tenía `PUBLISH_POST_QUEUE = "publish-post"`, un literal escrito a
mano cuando no existía `JOB_QUEUES`, **con una nota que decía que nada lo
verificaba**. El registro llegó después y nombró a esa cola `"publishing"`.

Medido contra pg-boss antes de tocar nada:

```
"publish-post" en ALL_JOB_QUEUES: false
FALLO  en "publish-post" -> Queue "publish-post" must be registered before
                            enqueuing inside a transaction
ENCOLO en "publishing"
```

`main.ts` registra `[...ALL_JOB_QUEUES]`, que no contiene `"publish-post"`, y
pg-boss se niega a encolar en una cola no registrada dentro de una transacción.

**Vivió con 82 tests de integración en verde por tres razones**, y lo que vale
de este hallazgo es que hacía falta arreglar las tres:

1. El nombre no salía de `JOB_QUEUES`. Una línea.
2. **El arnés de tests aceptaba cualquier nombre de cola.** Ahora valida contra
   `ALL_JOB_QUEUES`, lo que convierte a cada test de ruta que encola en una
   guarda — en vez de necesitar un test nuevo por cola.
3. **Nadie ejercitaba la ruta.** Y esto es lo que casi se me pasa: con el bug
   puesto y el arnés **ya estricto**, los 82 seguían verdes. Un guardián sin
   nadie que pase por delante no guarda nada. Los 9 tests de
   `schedule.int.test.ts` son los que faltaban; con el bug de vuelta, 5 se ponen
   en rojo.

Más un invariante estático: ninguna ruta escribe un nombre de cola a mano. El
que ya existía comparaba `JOB_QUEUES` contra el catálogo del worker y estaba
**ciego a las rutas**, que son el otro productor.

Tres guardas independientes para el mismo error, las tres verificadas en rojo.
Suena excesivo hasta que se cuenta que es la cuarta vez que este error aparece.

## 4 · `withoutCompany` no saltea RLS, y en desarrollo no se nota

Hallazgo de D, verificado por mí porque justifica un `SECURITY DEFINER` —o sea,
una excepción al aislamiento, que es lo más caro de aprobar a la ligera.

`quota_ledgers` tiene `FORCE ROW LEVEL SECURITY` y su política compara
`company_id` contra `app.current_company()`. Un barrido corre sin GUC, así que
esa función devuelve NULL y **un `UPDATE` pelado afecta cero filas sin error**.
`withoutCompany` documenta que se salió del scope; no saltea RLS.

Medido contra la base, mismo rol y mismo estado:

```
UPDATE pelado como fastgram_app, sin GUC  ->  0 filas afectadas, sin error
app.sweep_expired_daily_swipes(...)       ->  1 fila barrida
```

En desarrollo la conexión es superusuaria, saltea RLS, y el barrido *parece*
andar. Es la trampa 16 por cuarta vez: **funciona en desarrollo, no hace nada en
producción, y nadie se entera.**

El tamaño de la excepción, comprobado en `pg_proc`: `search_path` fijo, `proacl`
sólo `fastgram` y `fastgram_app`, **no recibe `company_id`** —no hay forma de
apuntarla a un tenant desde el payload de la cola— y devuelve un entero, no
filas.

## 5 · La trampa que introduje yo al coordinar

Les di a C y a D el mismo `DATABASE_URL`. El fixture de `apps/api` arranca con
un `truncate … restart identity cascade` sobre `companies` y `contents` — las
mismas tablas que siembra la suite del worker.

Lo vi antes de que llegaran a correr tests y le pasé a D una base aparte por
mensaje. **Y eso arreglaba esa sesión y dejaba la trampa para la siguiente**: el
default del fixture seguía en `fastgram`, así que `pnpm test:int` —que turbo
corre en paralelo— volvía a pisarse. La primera corrida pasó igual, por timing,
que es la peor forma de tenerlo.

Ahora la base se **deriva** del `DATABASE_URL` compartido (`fastgram` →
`fastgram_worker`) y la crea el `globalSetup` si falta. Derivada y no un literal,
para que un `DATABASE_URL` distinto —CI usa `fastgram_test`— arrastre su propia
base sin tener que pasar dos variables. Y desde el `globalSetup` y no desde el
`docker-compose`, porque un `initdb` sólo corre con el volumen vacío: a quien ya
tiene el contenedor levantado no le llegaría nunca.

Verificado borrando la base:

```
DROP DATABASE
[worker test:int] base: fastgram_worker
Tests  34 passed (34)
```

**Regla para la próxima tanda en paralelo:** dos agentes que corren tests de
integración no pueden compartir base, y arreglarlo por mensaje no alcanza — hay
que arreglarlo en el default, o vuelve.

## Lo que NO hice, y por qué

**No monté `HttpMediaRenderer` en el worker**, aunque es el paso obvio y B dejó
escrito cómo. Montarlo hoy **rompería todos los builds**, por tres cosas
medidas:

1. **Las 42 fuentes no existen.** Con `RENDER_FONT_STRICT=true`, el default
   `inter` da `font_unavailable`, que el adaptador traduce —correctamente— a
   `bad_request` permanente: pieza fallada y save reembolsado en **cada** build.
2. **El servicio exige grant firmado por defecto** y el puerto `MediaRenderer`
   no tiene por dónde pasarlo. Un grant estático sería per-workspace incorrecto
   y rompe `NFR-006`.
3. **Sin `RENDER_ALLOWED_MEDIA_PREFIXES`**, toda URL se rechaza.

Con el de memoria montado, el pipeline corre y el artefacto es sintético. Con el
real mal configurado, el pipeline cobra y reembolsa en bucle. El de memoria es
peor producto y mejor estado: es más honesto decir "el artefacto es sintético"
que tener un pipeline que factura y falla.

Queda como `P2-RENDER-015`, con los cuatro bloqueos escritos —el cuarto es de
diseño: **un slideshow de más de un slide no se puede construir por
`render()`**, porque `RenderResult` transporta un artefacto. Hay `renderAll()` y
el handler tiene que usarlo.
