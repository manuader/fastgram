# Modelo de costos — FastGram

**Tarea:** `P1-INFRA-001` · **Fecha de medición: 2026-09-21** · Plan de referencia: [`IMPLEMENTATION-PLAN.md`](IMPLEMENTATION-PLAN.md) §5
**Cuotas de referencia:** [`PRD.md`](../PRD.md) §16 · **NFR:** `PRD.md` §17

> **Regla de esta tarea:** *"ninguna cifra se asume"*. Todo número lleva etiqueta de procedencia.
> Todo precio fue consultado contra la página del proveedor **el 2026-09-21**. Los precios de IA
> y de cloud cambian en semanas: **este documento caduca**. Re-verificar antes de cualquier
> decisión de arquitectura o de pricing.

## Convención de etiquetas — se aplica a cada fila del documento

| Etiqueta | Significa |
|---|---|
| **`[LISTA]`** | Precio de lista publicado. Verificado contra la URL citada el 2026-09-21. |
| **`[DERIVADO]`** | Aritmética mía **sobre números `[LISTA]`**. El cálculo está escrito para que se pueda auditar. |
| **`[ESTIMACIÓN]`** | **Supuesto mío.** No está verificado contra nada. Es lo que hay que medir. |
| **`[UNKNOWN]`** | No se pudo verificar. Se dice qué haría falta para saberlo. |
| **`[VENDOR]`** | Afirmación del proveedor que **no** pude verificar de forma independiente. |

---

# 0. Resumen ejecutivo — las cuatro cosas que cambian decisiones

1. **El driver dominante no es el egress. Es la generación de video en GPU.**
   Un usuario Pro que gaste sus 2.000 créditos en video cuesta **$23,33/mes** `[DERIVADO]` sobre
   un plan de $149 — **15,7 % del precio del plan**. Todo lo demás junto (egress + render +
   LLM + storage + OCR) no llega a **$0,50/usuario/mes**. El plan §5 tiene el orden invertido.

2. **El sistema de créditos del PRD no refleja el costo.** Un crédito gastado en video cuesta
   **15,6×** un crédito gastado en imagen `[DERIVADO]`. El PRD hereda de Fastlane un tarifario
   (4 cr/imagen · 60 cr/video) que **no está calibrado contra el costo real del proveedor**.
   Es un defecto de diseño de producto, no de infraestructura, y hay que resolverlo en el PRD.

3. **La premisa de `ADR-006` no se sostiene para este producto, por dos razones distintas.**
   (a) FastGram **publica en TikTok/Instagram**: la audiencia masiva la sirven las plataformas,
   no nosotros. Nuestro egress son previews para el creador — centavos.
   (b) El egress $0 de R2 es real como **facturación**, pero los Service-Specific Terms de
   Cloudflare **exigen un servicio pago (Stream) para servir video por el CDN** fuera de
   Enterprise, y las docs de agosto 2026 **ya no mencionan a R2** como vía habilitada. Ver §4.4.

4. **El self-host de LLM con vLLM no se justifica en el horizonte visible.** El punto de cruce
   contra el gateway más barato verificado está en **~2.421 M tokens de output al mes**
   (≈ 921 tok/s sostenidos 24×7) `[DERIVADO]`, que en unidades de producto son unos
   **12.000 usuarios Growth al tope de su cuota** `[DERIVADO + ESTIMACIÓN]`. Para clasificación
   el cruce está tan arriba que es inalcanzable. Detalle y fórmula en §5.

---

# 1. Unidad de costeo

## 1.1 Qué consume un usuario, derivado de las cuotas del PRD §16

El PRD define el consumo por **cuatro cuotas independientes**, no por una. No existe "un usuario
activo" con un perfil único: existe un usuario que consume hasta cuatro topes distintos, y el
costo depende **de cómo los gasta**, no de cuántos son.

| Plan | Precio | Content saves | AI Studio credits | Workspaces | Human UGC videos |
|---|---|---|---|---|---|
| **Free** | $0 | "Limited content" `[UNKNOWN]` | 10 | 1 `[ESTIMACIÓN]` | — |
| **Starter** | $29/mes | 20 | 250 | 1 | — |
| **Growth** | $49/mes | 100 | 500 | 3 | 100 |
| **Pro** | $149/mes | Ilimitado `[UNKNOWN]` | 2.000 | 10 | 2.000+ |

Fuente: `PRD.md` §16.1, §16.2. El PRD declara esos valores *"tomados literalmente de la página
de precios oficial"*, verificados 2026-09-21.

## 1.2 Los créditos: la tabla de conversión que gobierna el costo

`PRD.md` §16.2 y §12 (línea 1517), CONFIRMED en la UI del producto original:

| Operación | Créditos | Tiempo declarado |
|---|---|---|
| Imagen de personaje | **4** | ~30–60 s |
| Imagen base / regeneración | **4** | ~30–60 s |
| **Video** (5 s o 10 s) | **60** | ~1–3 min |
| **Creación de influencer** (fine-tune LoRA) | **250** | ~15–20 min |

**Esta tabla es el corazón del modelo de costos**, porque es la única cuota que compra
directamente cómputo de GPU de terceros.

## 1.3 Definición operativa de "un usuario activo al mes"

No hay un solo número. Hay un **rango**, y el ancho del rango es el hallazgo:

> **Un usuario activo al mes = su cuota de content saves convertida en renders + su cuota de
> créditos convertida en GPU de terceros.** El segundo término domina, y su valor **varía 15,6×**
> según en qué gaste los créditos.

**Caso barato** (todos los créditos en imágenes) y **caso caro** (todos en video de 10 s):

| Plan | Créditos | Caso barato (imágenes) | Caso caro (video 10 s) | Ratio |
|---|---|---|---|---|
| Free | 10 | $0,01 | $0,12 | 15,6× |
| Starter | 250 | $0,19 | **$2,92** | 15,6× |
| Growth | 500 | $0,38 | **$5,83** | 15,6× |
| Pro | 2.000 | $1,50 | **$23,33** | 15,6× |

Todas `[DERIVADO]` — el cálculo está en §6.4, sobre precios `[LISTA]` de fal.ai y Replicate.

## 1.4 El multiplicador que el PRD esconde: la cola de Blitz

`PRD.md` línea 1111: *"La cola se rellena sola en background hasta ~5 items"*. Línea 1082: la
tarjeta muestra *"la pieza ya renderizada"*. Línea 1110: *"Rechazar **no** consume cuota"*.

**Consecuencia de costo:** el producto **genera y renderiza contenido que el usuario va a
rechazar, y por el que no cobra nada**. El ratio de aceptación de Blitz es **`[UNKNOWN]`** y es
el parámetro más importante que no está medido. Si la aceptación es del 20 %, cada content save
facturado arrastra **5 generaciones de LLM y 5 renders** no facturados.

Esto **no** afecta al driver dominante (la GPU de generación se dispara por créditos, no por
swipes), pero multiplica por ~5 los drivers de render y de tokens — que, como se verá, siguen
siendo despreciables incluso multiplicados por 5. Es un riesgo acotado, pero hay que medirlo
porque el **plan Free da acceso a Blitz** (`PRD.md` §16.1): un usuario gratuito que sólo
swipea genera costo y cero ingreso.

## 1.5 Storage por usuario: no se puede derivar

`PRD.md` §16.2 lista *"Storage agregado | por plan"* **sin ningún número**. Los límites de
subida sí están (`NFR-013`: imágenes 10 MB · videos 50 MB). El tamaño del **output renderizado**
tampoco está en el PRD.

→ **`[UNKNOWN]`**, detallado en §9.

---

# 2. Ordenamiento real de los drivers

El plan §5 ordena los drivers *"por impacto esperado"*. Medido, el orden es otro:

| Orden **medido** | Driver | Orden en el plan §5 | Costo/usuario/mes (plan Growth, caso caro) |
|---|---|---|---|
| **1** | **GPU de generación — video** | 3 | **$5,83** `[DERIVADO]` |
| **2** | **GPU de generación — LoRA de influencer** | 3 | hasta $4,00 `[DERIVADO]` |
| 3 | Cómputo base (CPU + Postgres) | 2 y 6 | costo **fijo**, no por usuario — ver §3.3 |
| 4 | Egress + storage de media | **1** | ~$0,02–$0,21 `[DERIVADO + ESTIMACIÓN]` |
| 5 | Tokens de LLM | 4 | ~$0,01–$0,05 `[DERIVADO + ESTIMACIÓN]` |
| 6 | CPU de render | **2** | ~$0,001–$0,005 `[DERIVADO + ESTIMACIÓN]` |
| 7 | ASR / OCR | 5 | ~$0,00 self-host · ver §3.5 |

> **El plan puso en los dos primeros puestos (egress y CPU de render) los dos drivers que
> resultaron estar entre los tres últimos.** La razón del error es razonable y vale registrarla:
> el plan razonó *"producto de video ⇒ el egress domina"*, que es correcto para un producto de
> **distribución** de video (Netflix, YouTube). FastGram es un producto de **producción** de
> video que **entrega el archivo a TikTok/Instagram y deja que ellos lo distribuyan**. El egress
> masivo lo paga la plataforma social, no nosotros.

---

# 3. Los seis drivers del plan §5, uno por uno

## 3.1 Driver 1 del plan — Egress de media

**Qué lo dispara, en unidades del producto:**
- preview de cada tarjeta de Blitz (≈5 en cola por workspace, la mayoría rechazadas)
- thumbnails del calendario y de la Library
- descargas explícitas del usuario
- **una** subida por post a cada plataforma social (TikTok/Instagram/YouTube/LinkedIn)

**Lo que NO lo dispara:** las vistas de la audiencia final. El PRD §3 describe publicación
**nativa**: el video vive en TikTok una vez subido. Esto es lo que rompe la premisa del plan.

**Precios verificados** — ver la comparativa completa en §4.

**Cálculo hasta costo/usuario/mes** `[DERIVADO + ESTIMACIÓN]`:

```
Supuesto [ESTIMACIÓN]: preview 1080×1920 de ~20 s a ~4 Mbps  ≈ 10 MB
Supuesto [ESTIMACIÓN]: 5 previews vistos por cada save aceptado (cola de Blitz, §1.4)

Growth = 100 saves/mes × 5 previews × 10 MB           =  5,0 GB/mes
       + 100 subidas a plataforma × 10 MB             =  1,0 GB/mes
                                                        ─────────────
                                                         6,0 GB/mes

Costo de esos 6 GB:
  R2 (egress $0)                    → $0,00   [LISTA: $0/GB]
  Bunny Volume Network              → $0,03   [DERIVADO: 6 × $0,005]
  Bunny Standard EU/NA              → $0,06   [DERIVADO: 6 × $0,01]
  AWS CloudFront (tras 1 TB gratis) → $0,51   [DERIVADO: 6 × $0,085]
  S3 directo a Internet             → $0,54   [DERIVADO: 6 × $0,090]
```

**La diferencia entre la opción más cara y la más barata es $0,54/usuario/mes en un plan de
$49 — el 1,1 %.** Es real, pero no es un driver de primer orden.

**Palanca:** la del plan sigue siendo correcta (*"nunca servir el master para un preview"*),
pero su valor es de **centavos**, no de la factura. La palanca que sí importa es **no elegir el
proveedor por el egress** sino por el riesgo contractual de servir video (§4.4).

---

## 3.2 Driver 2 del plan — CPU de render

**Qué lo dispara:** cada content save aceptado (1 build) + cada preview de la cola de Blitz +
cada edición que invalide el hash de build.

**Precio de lista verificado — y un hallazgo que afecta a `ADR-013`:**

> **Hetzner subió los precios de la línea CCX hasta un +176 %, con efecto 15 de junio de 2026,
> 8 AM CEST.** `[LISTA]` — https://docs.hetzner.com/general/infrastructure-and-availability/price-adjustment/

| Plan | vCPU dedicados | RAM | Tráfico incl. (EU) | €/hora | Precio **anterior** | Precio **actual** | Δ |
|---|---|---|---|---|---|---|---|
| CCX13 | 2 | 8 GB | 20 TB | 0,0689 | €15,99 | **€42,99/mes** | +169 % |
| CCX23 | 4 | 16 GB | 20 TB | 0,1378 | €31,49 | **€85,99/mes** | +173 % |
| CCX33 | 8 | 32 GB | 30 TB | 0,2219 | €62,49 | **€138,49/mes** | +122 % |
| CCX43 | 16 | 64 GB | 40 TB | 0,4423 | €124,99 | **€275,99/mes** | +121 % |
| CCX53 | 32 | 128 GB | 50 TB | 0,8550 | €249,99 | **€533,49/mes** | +113 % |
| CCX63 | 48 | 192 GB | 60 TB | 1,3678 | €374,49 | **€853,49/mes** | +128 % |

Precios `[LISTA]` (EUR, **excl. VAT y excl. IPv4**, Alemania/Finlandia). Specs y tráfico `[LISTA]`
desde https://www.hetzner.com/cloud/general-purpose/. Las tablas de precio de las páginas de
producto de Hetzner se inyectan por JS y **vuelven vacías** incluso en navegador real; los
precios salen de la página de docs (ID GE-D9256), que es oficial y sí renderiza.

| Concepto asociado | Precio `[LISTA]` | Fuente |
|---|---|---|
| Tráfico saliente extra | **€1 ($1,20) / TB**; entrante e interno gratis; bloques de 100 MB redondeando arriba | docs.hetzner.com/robot/general/traffic/ · docs.hetzner.com/cloud/billing/faq/ |
| IPv4 primaria | **€0,50/mes** (€0,0008/h) | docs.hetzner.com/cloud/servers/primary-ips/overview/ |
| IPv6 primaria | *"free"* | ídem |

> Nota de método: los clientes con precio legacy **no** están afectados salvo que modifiquen el
> servidor — *"Certain changes to servers with legacy pricing may trigger a switch to the current
> pricing."* `[LISTA]`. Como FastGram no tiene infra todavía, **paga el precio nuevo**.

> ⚠️ **Región USA: el tráfico incluido se desploma.** Mismas specs y precio similar, pero el
> tráfico incluido cae de 20–40 TB a **1–4 TB** `[LISTA]` (CCX33 USA: 3 TB, $165,99/mes). Si el
> render sirve desde ASH/HIL, el excedente de egress se come la ventaja. **Decidir región mirando
> el tráfico, no el precio de la instancia.**

> ⚠️ **Un vCPU de Hetzner Cloud es un *thread*, no un core.** Textual del FAQ oficial
> (https://docs.hetzner.com/cloud/servers/faq/): *"Here one vCPU equals one thread of a physical
> CPU core."* **CCX33 = 8 threads ≈ 4 cores físicos.** Para FFmpeg, que es CPU-bound real, esto
> divide por dos el throughput esperado de la instancia. Es exactamente el tipo de dato que no se
> deduce del precio y que descoloca un sizing.

**Consecuencia: para el render conviene un dedicado, no cloud.** `[LISTA]`, misma página de docs:

| Opción | Cores **físicos** | RAM | Tráfico | €/mes | Setup |
|---|---|---|---|---|---|
| **AX42-1** (Ryzen 7 PRO 8700GE) | **8** | 64 GB DDR5 ECC | **Ilimitado** (1 Gbit/s) | **€97,30** | €49 |
| AX102-1 (Ryzen 9 7950X3D) | **16** | hasta 128 GB DDR5 ECC | **Ilimitado** (1 Gbit/s) | €257,30 | €129 |
| CCX33 (cloud, comparación) | ~4 | 32 GB | 30 TB | €138,49 | — |

> **AX42-1 da ~2× el throughput de CPU de un CCX33 por el 70 % del precio, con tráfico
> ilimitado** `[DERIVADO]`. Contra: setup de €49, sin creación por API en segundos, sin rescale.
> **Para `services/render`, que el plan describe como "sin estado, escala por CPU", el dedicado
> es el encaje correcto**; el cloud sirve para `web`/`api`/`worker`, que sí necesitan elasticidad.

**Cálculo hasta costo/usuario/mes** `[DERIVADO + ESTIMACIÓN]`:

```
CCX33: €138,49/mes ÷ (8 threads × 730 h) = €0,0237 por thread-hora   [DERIVADO]
AX42-1: €97,30/mes ÷ (8 cores × 730 h)   = €0,0167 por core-hora     [DERIVADO]

Supuesto [ESTIMACIÓN]: un render de 1080×1920 de ~20 s consume ~60 s de 1 core
  (composición + overlay + encode x264). NO MEDIDO — ver experimento E-2 en §9.

Growth = 100 saves × 5 (cola) = 500 renders/mes
       = 500 × 60 s = 8,33 core-hora
       en AX42-1:  8,33 × €0,0167 = €0,14/usuario/mes   [DERIVADO sobre un supuesto]
       en CCX33:   8,33 × €0,0237 = €0,20/usuario/mes   [DERIVADO sobre un supuesto]
```

**Entre €0,14 y €0,20/usuario/mes** con el multiplicador ×5 de la cola. Sin la cola, €0,03–€0,04.
Sobre un plan de $49, entre el 0,06 % y el 0,4 %.

**Contraste build-vs-buy** — cuánto costaría **comprar** el transcode en vez de correr FFmpeg:

| Opción | Precio | Growth (500 renders × 20 s = 167 min output) |
|---|---|---|
| FFmpeg en CCX33 propio | €0,0237/vCPU-h `[DERIVADO]` | **€0,20** |
| AWS Elemental MediaConvert, Basic HD | $0,0075/min normalizado × 2 (mult. HD) = **$0,015/min** `[LISTA]` | **$2,51** `[DERIVADO]` |
| Mux — storage | $0,00300/min/mes `[LISTA]` | — |
| Mux — delivery | $0,00100/min tras 100.000 min gratis `[LISTA]` | — |

Fuentes: https://aws.amazon.com/mediaconvert/pricing/ · https://www.mux.com/pricing/video

> **Esto valida `ADR-007` (FFmpeg propio) por una segunda vía, independiente del argumento de
> licencia de Remotion:** comprar el encode cuesta ~12× más que correrlo. Pero **ambos números
> son despreciables** frente al driver dominante, así que la decisión de `ADR-007` no debería
> haberse tomado por costo de render — se tomó bien, por el peaje por unidad de la licencia.

**Palanca del plan (cache por hash del payload de build): correcta pero de bajo retorno.**
Ahorra céntimos. Su valor real es **de latencia** (`NFR-001`: el build tarda 30 s–2 min), no de
costo. Vale la pena implementarla, pero justificarla por costo sería vender humo.

---

## 3.3 Driver 6 del plan — Postgres y cómputo base

Es el único driver que **no escala por usuario**: es un piso fijo. A baja escala es el gasto
más grande del proyecto; a escala se diluye.

**Self-host en Hetzner** (`ADR-003` + `ADR-013`), precios `[LISTA]` post-junio-2026:

| Rol | Plan | Precio |
|---|---|---|
| `web` + `api` | CCX23 (4 vCPU / 16 GB) | €85,99/mes |
| `worker` | CCX23 (4 vCPU / 16 GB) | €85,99/mes |
| `render` | **AX42-1 dedicado** (8 cores / 64 GB / tráfico ilimitado) | €97,30/mes + €49 setup |
| Postgres | CCX23 (4 vCPU / 16 GB) | €85,99/mes |
| IPv4 × 4 | €0,50/mes c/u | €2,00/mes |
| **Piso mínimo de producción** | | **€357,27/mes** `[DERIVADO]` |

Más staging y dev. Sin alta disponibilidad, sin réplica de lectura, sin backups gestionados —
`P1-INFRA-003` exige *"probar un restore"*, que es trabajo aparte.

> **Hetzner no ofrece Postgres gestionado.** Verificado sobre la navegación de productos de
> hetzner.com: Dedicated, Cloud, Web & Managed, Storage y Services — **ningún producto de base de
> datos gestionada**. Con `ADR-003` hay que self-hostear Postgres o salir a otro proveedor.
> (Existen terceros —Ubicloud, Autobase— que corren Postgres gestionado *sobre* Hetzner; sus
> precios son **`[UNKNOWN]`**.)

**Alternativas gestionadas, precios `[LISTA]` verificados 2026-09-21:**

| Proveedor | Tier de producción (~4–8 GB RAM) | $/mes | Storage | Egress |
|---|---|---|---|---|
| **Supabase** Pro + Medium (4 GB shared) | $25 + $60 − $10 de crédito | **$75** `[DERIVADO]` | 8 GB incl. · $0,125/GB extra | 250 GB incl. · **$0,09/GB** |
| **Supabase** Pro + Large (2 vCPU ded., 8 GB) | $25 + $110 − $10 | **$125** `[DERIVADO]` | ídem | ídem |
| **DigitalOcean** Managed PG (2 vCPU / 4 GiB) | — | **$60,90** | 60 GiB incl. · $0,215/GiB extra | `[UNKNOWN]` |
| **DigitalOcean** Managed PG (4 vCPU / 8 GiB) | — | **$122,10** | 140 GiB incl. | `[UNKNOWN]` |
| **Crunchy Bridge** Standard-8 (2 vCPU / 8 GB) | *"Fully inclusive for all machine costs, hosting, backups, and connection pooling"* | **$140** | $0,10/GB | `[UNKNOWN]` |
| **Neon** Launch, 2 CU (8 GB) siempre encendido | $0,106/CU-hora × 2 × 730 h | **$154,76** `[DERIVADO]` | **$0,35/GB-mes** | 500 GB incl. · **$0,10/GB** |
| **Neon** Scale, 2 CU siempre encendido | $0,222/CU-hora × 2 × 730 h | **$324,12** `[DERIVADO]` | $0,35/GB-mes | ídem |

Fuentes: supabase.com/pricing · digitalocean.com/pricing/managed-databases ·
crunchydata.com/pricing · neon.com/pricing

> **Neon ya no tiene planes de precio fijo.** Textual: *"Paid plans are pay-as-you-go: usage is
> metered hourly and billed at the end of the month, with no monthly minimum."* Su scale-to-zero
> abarata mucho el dev y el staging, pero **para una API con tráfico constante no aplica** — el
> cálculo de arriba asume 730 h encendido, que es el caso real de producción. Su storage a
> **$0,35/GB-mes es 23× el de R2**: no guardar media ahí.

**Comparación:** el Postgres self-hosted en un CCX23 (€85,99 ≈ $101) sale parecido a Supabase
Pro+Medium ($75) y más barato que Neon ($155) o Crunchy ($140) — **pero sin backups gestionados,
sin pooling y sin el restore probado que exige `P1-INFRA-003`.** A esta escala la diferencia de
precio es de decenas de dólares al mes: **conviene decidirlo por operación, no por costo.**

**Hosting del Next.js**, si se quisiera salir del self-host de `ADR-013` — `[LISTA]`:

| Opción | Precio | Data transfer |
|---|---|---|
| **Vercel** Hobby | $0/mes | — |
| **Vercel** Pro | **$20/mes por developer seat** | *"1TB / month included; then starting at $0.15 per GB"*; invocations desde $0,60/M; build desde $0,007/min |
| **Cloudflare Workers** Free | $0 | 100.000 req/día |
| **Cloudflare Workers** Paid | **$5/mes mínimo** | 10 M req/mes incl., luego $0,30/M; 30 M CPU-ms incl., luego $0,02/M CPU-ms. Textual: *"There are no additional charges for data transfer (egress) or throughput (bandwidth)."* |

Fuentes: vercel.com/pricing · developers.cloudflare.com/workers/platform/pricing/

> **El $0,15/GB de Vercel pasado el 1 TB es 15× el egress de bunny.net y ∞× el de R2.** Servir
> media por Vercel sería el único camino que devolvería al egress al puesto #1 de este
> documento. **No hacerlo.** `ADR-013` (self-host en cómputo barato) está bien por este motivo,
> que el ADR no menciona.

**Palanca del plan (índices `(companyId, createdAt)` desde el principio, particionar `posts` y
`judgment_records`): correcta y barata.** Pero su efecto es de **latencia y de aplazar el
próximo upgrade de instancia**, no de reducir la factura del mes que viene.

---

## 3.4 Driver 4 del plan — Tokens de LLM

Ver §5 completo. Resumen del cálculo por usuario:

```
Supuesto [ESTIMACIÓN]: una sugerencia de Blitz = 1.200 tok input + 400 tok output
  (caption + hook + aiExplanation con decodificación restringida por JSON-schema)
Supuesto [ESTIMACIÓN]: 5 sugerencias generadas por cada save aceptado (cola, §1.4)

Growth = 100 saves × 5 = 500 sugerencias/mes
       = 600.000 tok input + 200.000 tok output

  gpt-oss-120b     ($0,15 / $0,60 [LISTA])  = $0,090 + $0,120 = $0,210/mes  [DERIVADO]
  Nemotron 3.5 30B ($0,05 / $0,20 [LISTA])  = $0,030 + $0,040 = $0,070/mes  [DERIVADO]
  Llama 3.1 8B     ($0,02 / $0,04 [LISTA])  = $0,012 + $0,008 = $0,020/mes  [DERIVADO]
```

**Entre $0,02 y $0,21 por usuario Growth al mes.** Entre el 0,04 % y el 0,4 % de un plan de $49.

**Palanca del plan:** *"el puerto `Judgment` existe en parte por esto: clasificar no necesita un
modelo generativo"*. La intuición es correcta como **arquitectura**, pero como **argumento de
costo no se sostiene a los precios de hoy**: ver §7, donde se muestra que Jev es ~2× más caro
por token de input que un modelo open-weight de 8B en el gateway más barato verificado.

---

## 3.5 Driver 5 del plan — ASR / OCR

**Qué lo dispara:** `AI-016` (alta social, OCR sobre imágenes y miniaturas), `JV-1` (clasificación
del catálogo), `INT-015`/`INT-016`. Cap de 24 ítems por análisis (`OQ-18`).

**Precio de las alternativas gestionadas, para saber qué se ahorra al self-hostear:**

| Servicio | Precio `[LISTA]` | URL |
|---|---|---|
| Google Cloud Vision — `TEXT_DETECTION` | **$1,50 / 1.000 imágenes** (1.001–5 M/mes); $0,60/1.000 por encima de 5 M; primeras 1.000/mes gratis | https://cloud.google.com/vision/pricing |
| Deepgram Nova-3 monolingüe (pre-grabado) | **$0,0043 / min** | https://deepgram.com/pricing |
| Deepgram Nova-3 multilingüe | $0,0052 / min | ídem |
| OpenAI `gpt-4o-mini-transcribe` | **$0,003 / min** | https://developers.openai.com/api/docs/pricing |
| OpenAI `gpt-4o-transcribe` / Whisper | $0,006 / min | ídem |

**Cálculo del ahorro de `ADR-011` (PaddleOCR self-host)** `[DERIVADO + ESTIMACIÓN]`:

```
Alta social: 24 ítems × ~3 imágenes/ítem = 72 imágenes  [ESTIMACIÓN sobre el cap de OQ-18]
  Google Vision: 72 × $0,0015 = $0,108 por alta          [DERIVADO]
  PaddleOCR en CPU propia: ~0 marginal (usa el CCX33 ya pagado)

El alta ocurre UNA VEZ por workspace, no cada mes.
```

**$0,11 por alta, una sola vez.** El ahorro de self-hostear OCR es de **centavos por usuario de
por vida**. `ADR-011` sigue siendo la decisión correcta, pero **su justificación es de calidad,
no de costo** — y el plan ya lo dice así: *"el caso real es texto estilizado sobre video, donde
Tesseract rinde mal"*. Ese es el argumento bueno; el de costo no hace falta.

**`ADR-012` (ASR self-host, Fase 2) — el plan afirma algo que no se verifica.** El plan dice:
*"el costo por minuto de audio a escala de catálogo hace que las APIs de transcripción sean el
segundo driver de costo después del render"*. A $0,003/min `[LISTA]`, transcribir **el catálogo
completo de 25.000 videos** de `F-041`, asumiendo 30 s cada uno `[ESTIMACIÓN]`:

```
25.000 × 0,5 min × $0,003/min = $37,50 por pasada completa    [DERIVADO]
```

**$37,50 para transcribir todo el catálogo, una vez.** Eso no es "el segundo driver de costo":
es menos que un día de un CCX33. **`ADR-012` debería revisarse**: diferirlo a Fase 2 sigue
estando bien por `D-03`, pero cuando entre, **empezar con Deepgram u OpenAI y self-hostear sólo
si aparece un motivo que no sea el precio** (privacidad, latencia, idiomas). Operar
faster-whisper en GPU cuesta más en tiempo de ingeniería de lo que ahorra.

---

## 3.6 Driver 3 del plan — GPU de generación · **el driver dominante**

Sección completa en §6. Resumen: entre **$0,01 y $23,33 por usuario/mes** según el plan y según
en qué gaste los créditos. Es **dos órdenes de magnitud** más grande que cualquier otro driver.

---

# 4. Comparativa de storage y egress: R2 vs S3 vs B2

## 4.1 Precios de lista verificados

Todo `[LISTA]`, consultado 2026-09-21.

### Cloudflare R2 — https://developers.cloudflare.com/r2/pricing/ (la página declara *"Last updated Aug 7, 2026"*)

| Concepto | Standard | Infrequent Access |
|---|---|---|
| Storage | **$0,015 / GB-mes** | $0,01 / GB-mes |
| Class A ops (escritura) | $4,50 / millón | $9,00 / millón |
| Class B ops (lectura) | $0,36 / millón | $0,90 / millón |
| Data Retrieval | ninguno | **$0,01 / GB** |
| **Egress a Internet** | **Free** | **Free** |

Free tier: 10 GB-mes · 1 M Class A · 10 M Class B. *"The free tier only applies to Standard
storage, and does not apply to Infrequent Access storage."*

**Tres trampas verificadas, textuales:**
- **Infrequent Access cobra retrieval a $0,01/GB.** Para media que se sirve repetidamente, leer
  1 GB cuesta más que guardarlo un mes. **IA no sirve para previews de Blitz.**
- **Mínimo de 30 días en IA:** *"you will be charged for the object for the minimum storage
  duration even if the object was deleted or moved before the duration specified."*
- **Redondeo hacia arriba:** *"If you have used 1.1 GB-month, you will be billed for 2 GB-month."*

El `$0` de egress lleva footnote, y el footnote importa:
> *"Egressing directly from R2, including via the Workers API, S3 API, and r2.dev domains does
> not incur data transfer (egress) charges and is free. If you connect other metered services to
> an R2 bucket, you may be charged by those services."*

### AWS S3 — us-east-1

Fuente: https://aws.amazon.com/s3/pricing/ más la **API oficial de pricing de AWS**
(`pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/us-east-1/index.json`,
`publicationDate: 2026-09-18`; y `AWSDataTransfer`, `publicationDate: 2026-09-16`).
Las tablas HTML de la página visual se renderizan por JS y no son fetcheables — los números
vienen de la API oficial, que es la misma fuente que alimenta la página.

| Concepto | Precio |
|---|---|
| S3 Standard, primeros 50 TB | **$0,023 / GB-mes** |
| PUT/COPY/POST/LIST | $0,005 / 1.000 |
| GET y demás | $0,0004 / 1.000 |
| Data Transfer OUT, primeros 100 GB/mes | **Gratis** (agregado a **toda** la cuenta AWS, no sólo S3) |
| DTO 0–10 TB | **$0,090 / GB** |
| DTO 10–50 TB | $0,085 / GB |
| DTO 50–150 TB | $0,070 / GB |
| DTO > 150 TB | $0,050 / GB |

**Vía CloudFront** (https://aws.amazon.com/cloudfront/pricing/pay-as-you-go/), que es como
realmente se serviría video: **el origin fetch S3 → CloudFront es gratis** —
*"Free for origin fetches from any AWS origin such as Amazon Simple Storage Service (S3)..."*

| CloudFront DTO (US/MX/CA) | Precio |
|---|---|
| Primer 1 TB | **Free** |
| Siguientes 9 TB | **$0,085 / GB** |
| Siguientes 40 TB | $0,080 / GB |
| Siguientes 100 TB | $0,060 / GB |
| Siguientes 350 TB | $0,040 / GB |
| Sobre 5 PB | $0,020 / GB |

### Backblaze B2 — https://www.backblaze.com/cloud-storage/pricing

| Concepto | Valor |
|---|---|
| Storage | **$6,95 / TB / 30 días** (≈ $0,00695/GB-mes `[DERIVADO]` — la página publica sólo $/TB) |
| Storage gratis | primeros 10 GB |
| **Egress gratis** | **3× el storage promedio mensual** |
| Egress por encima | **$0,01 / GB** |
| Class A, B, C | **Gratis** |
| Class D | $0,004 / 10.000 (primeras 2.500/día gratis) |
| Mínimos | ninguno de tamaño ni de duración |

**El dato que cambia la comparación** — textual de la página:
> *"Backblaze B2 offers unlimited free egress when downloading to or through partner content
> delivery networks (CDNs) and compute services, including Fastly, Cloudflare, bunny.net,
> CacheFly, CoreWeave, Equinix Metal, Vultr, and phoenixNAP."*

La marca *"Bandwidth Alliance"* **ya no aparece** en la página de Backblaze — hablan de
"partner CDNs". La sustancia (egress gratis hacia/por Cloudflare y bunny.net) sí está verificada;
el nombre formal del programa es `[UNKNOWN]`.

### Alternativa que el plan no considera: bunny.net

https://bunny.net/pricing/ y https://bunny.net/storage/ — `[LISTA]`

| Concepto | Precio |
|---|---|
| CDN Standard, Europa y Norteamérica | **$0,01 / GB** |
| CDN Standard, Asia y Oceanía | $0,03 / GB |
| CDN Standard, Sudamérica | $0,045 / GB |
| **CDN Volume Network** (10 PoPs), primeros 500 TB | **$0,005 / GB** |
| Edge Storage HDD, primera región | $0,01 / GB-mes |
| Edge Storage SSD | $0,02 / GB-mes por región |
| Mínimo mensual | $1 |
| Fees por request | **ninguno** |

## 4.2 La comparación, en la escala real de este producto

Usando los 6 GB/mes/usuario de §3.1 y 500 MB de storage acumulado por usuario `[ESTIMACIÓN]`:

| Arquitectura | Storage 500 MB | Egress 6 GB | **Total/usuario/mes** |
|---|---|---|---|
| **R2 Standard** | $0,0075 | **$0,00** | **$0,0075** `[DERIVADO]` |
| **B2 + bunny.net Volume** | $0,0035 | $0,030 | **$0,0335** `[DERIVADO]` |
| **B2 + bunny.net Standard EU/NA** | $0,0035 | $0,060 | **$0,0635** `[DERIVADO]` |
| **B2 directo** (dentro del 3× gratis) | $0,0035 | $0,00 | **$0,0035** `[DERIVADO]` |
| **S3 + CloudFront** (pasado 1 TB gratis) | $0,0115 | $0,510 | **$0,5215** `[DERIVADO]` |

## 4.3 ¿Sigue siendo cierto que "el egress $0 de R2 domina la factura"? **No.**

**Verificación de la afirmación de `ADR-006` y del plan §5, driver 1.** Dos motivos independientes:

**(a) La aritmética.** La diferencia entre la opción más cara (S3+CloudFront, $0,52) y la más
barata (B2 directo, $0,0035) es **$0,52 por usuario al mes**. El driver dominante de este
producto es **$5,83–$23,33 por usuario al mes**. El egress es entre **11× y 45× más chico** que
el driver que sí manda. **No domina la factura: es ruido comparado con la GPU.**

**(b) La premisa del producto.** El plan razona *"en un producto de video el tráfico de salida
domina la factura: cada preview en Blitz, cada thumbnail del calendario y cada descarga sirve
bytes"*. Los tres ejemplos son correctos, pero los tres los consume **el creador**, que es un
único usuario pago. FastGram **no sirve video a la audiencia final**: `PRD.md` §3 y `INT-009`
describen publicación **nativa** a TikTok/Instagram. El video de un post viral con 1,3 M de
views (ejemplo literal del PRD, línea 1067) **se sirve desde TikTok, con el ancho de banda de
TikTok**. Nuestro egress por ese post es: una subida.

> **Un producto que *distribuye* video tiene el egress como driver 1. Un producto que *produce*
> video y se lo entrega a las plataformas, no.** FastGram es lo segundo. Es la corrección de
> modelo mental más importante de este documento.

**`ADR-006` sigue siendo una decisión defendible** — R2 es la opción más barata de la tabla y es
S3-compatible, que es lo que hace viable MinIO en local. Pero **la razón escrita en el ADR es
falsa**, y una decisión sostenida por una razón falsa se reabre mal. Habría que reescribir la
justificación.

## 4.4 El riesgo que sí importa y que ningún ADR menciona: los términos de Cloudflare para video

**La cláusula §2.8 del ToS que solía prohibir "non-HTML content" ya no existe.** Verificado
contra https://www.cloudflare.com/terms/ : cero coincidencias de "non-HTML" y de
"disproportionate"; el articulado salta de `2.7 Acceptable Use` a la Sección 3. El blog oficial
https://blog.cloudflare.com/updated-tos/ (16-may-2023) confirma que la movieron
*"to a new CDN-specific section in our Service-Specific Terms"*.

**Dónde vive hoy** — https://www.cloudflare.com/service-specific-terms-application-services/,
sección *"Content Delivery Network (Free, Pro, or Business)"*, textual:

> *"Unless you are an Enterprise customer, Cloudflare offers specific Paid Services (e.g., the
> Developer Platform, Images, and Stream) that you must use in order to serve video and other
> large files via the CDN. Cloudflare reserves the right to disable or limit your access to or
> use of the CDN [...] if you use or are suspected of using the CDN without such Paid Services
> to serve video or a disproportionate percentage of pictures, audio files, or other large files."*

**Tres fuentes oficiales de Cloudflare se contradicen sobre si R2 es una vía habilitada:**

| Fuente | Fecha | ¿R2 habilita servir video por el CDN? |
|---|---|---|
| `blog.cloudflare.com/updated-tos/` | 16-may-2023 | **Sí, explícito:** *"customers can serve video and other large files using the CDN so long as that content is hosted by a Cloudflare service like Stream, Images, or R2"* |
| Service-Specific Terms (contrato vigente) | actual | **Ambiguo:** nombra *"the Developer Platform, Images, and Stream"*. R2 es parte del Developer Platform, pero **no se lo nombra** |
| Docs `delivering-videos-with-cloudflare` | *Last updated Aug 25, 2026* | **No lo menciona: R2 aparece 0 veces.** Sólo *"Option 1: Cloudflare Stream"* y *"Option 2: Stream Delivery (Enterprise only)"* |

La página de docs más reciente dice, textual:
> *"If you are on a Free, Pro, or Business Plan and your application appears to be serving videos
> or a disproportionate amount of large files without using the appropriate paid service as
> described below, Cloudflare may redirect your content or take other actions to protect quality
> of service."*

**El riesgo no es que cobren de más. Es que degraden o corten el servicio.** Y el precio de la
vía inequívocamente soportada es de otro orden:

**Cloudflare Stream** — https://developers.cloudflare.com/stream/pricing/ `[LISTA]`
- Storage: **$5/mes por cada 1.000 minutos** de capacidad
- Delivery: **$1 por 1.000 minutos entregados** (= $0,001/min entregado)
- *"Ingress and encoding are always free"*; sin egress adicional
- Sin free tier de storage ni de delivery de video

```
Growth = 500 previews × 20 s = 167 min entregados/mes → $0,167/mes  [DERIVADO]
       + storage de 100 videos × 20 s = 33 min → $0,17/mes          [DERIVADO]
                                                   ───────────────
                                                    ~$0,34/mes/usuario
```

Sigue siendo chico, pero es **45× el costo de R2** y **cambia la ecuación de la tabla §4.2**.

**Dos consecuencias prácticas:**
1. **`r2.dev` no sirve para producción.** Textual de
   https://developers.cloudflare.com/r2/buckets/public-buckets/ : *"Public access through
   `r2.dev` subdomains is rate-limited and should only be used for development purposes."*
   Producción exige custom domain, y ahí se entra en el alcance del CDN y de sus términos.
2. **`B2 + bunny.net` es la alternativa que esquiva el problema entero**, a $0,03/usuario/mes
   `[DERIVADO]`, sin ambigüedad contractual sobre video y sin fees por request. Merece ser
   evaluada como alternativa real a `ADR-006`, no como plan B.

**`[UNKNOWN]`: si R2 + Workers está permitido hoy para servir video en Free/Pro/Business.**
Las fuentes oficiales están en conflicto y no se resolvió. **Requiere confirmación escrita de
Cloudflare antes de comprometer la arquitectura** (experimento E-1, §9).

---

# 5. LLM open-weight: la foto de hoy, fechada

`ADR-009` deliberadamente no fija modelo ni precio. Esta sección es esa foto, **válida al
2026-09-21 y no después**.

## 5.1 Precios de lista por gateway

Todo `[LISTA]`, en USD por millón de tokens.

| Gateway | Modelo | Input | Output | URL |
|---|---|---|---|---|
| **DeepInfra** | Mistral Nemo | **$0,019** | $0,03 | https://deepinfra.com/pricing |
| **DeepInfra** | Meta-Llama 3.1 8B | **$0,02** | **$0,04** | ídem |
| DeepInfra | Gemma-3 4B | $0,05 | $0,10 | ídem |
| DeepInfra | Mistral Small 24B | $0,05 | $0,08 | ídem |
| DeepInfra | Gemma-3 27B | $0,08 | $0,16 | ídem |
| DeepInfra | Llama-3.3 70B | $0,10 | $0,32 | ídem |
| **Groq** | gpt-oss-20b | $0,075 | $0,30 | https://console.groq.com/docs/models |
| **Groq** | gpt-oss-120b | $0,15 | $0,60 | ídem |
| Groq | Qwen3.8-27B | $0,80 | $4,00 | ídem |
| **Fireworks** | Nemotron 3.5 Lightning 30B | **$0,05** | **$0,20** | https://docs.fireworks.ai/serverless/pricing |
| Fireworks | GLM 5.3 Flash | $0,15 | $0,50 | ídem |
| Fireworks | gpt-oss-120b (Standard) | $0,15 | $0,60 | ídem |
| Fireworks | DeepSeek V4 Flash | $0,22 | $0,66 | ídem |
| **Together** | gpt-oss-120B | $0,15 | $0,60 | https://www.together.ai/pricing |
| Together | Qwen3.8 Flash | $0,15 | $0,47 | ídem |
| Together | Qwen3.5 9B | $0,17 | $0,25 | ídem |
| Together | Llama 3 8B Instruct Lite | $0,14 | $0,14 | ídem |

**Fireworks publica además una regla por tamaño** para modelos no listados `[LISTA]`:
< 4B → $0,10/M · 4–16B → $0,20/M · > 16B → $0,90/M. Y: *"Batch inference is billed at 50% of
serverless pricing on both input and output."* — **el batch a mitad de precio es directamente
aplicable a `JV-1`** (clasificación del catálogo, que es offline).

## 5.2 Decodificación restringida por JSON-schema: quién la soporta

`ADR-009` exige *"decodificación restringida por JSON-schema"* para el `LlmJudgmentAdapter`.
Verificado:

| Gateway | Soporte | Costo extra | Evidencia |
|---|---|---|---|
| **DeepInfra** | `json_object` y **`json_schema` con `"strict": true`** | ninguno documentado | https://docs.deepinfra.com/chat/structured-outputs |
| **Together** | Sí, vía `response_format` | ninguno documentado | https://docs.together.ai/docs/json-mode — *"Supported models can return JSON that conforms to any schema you supply, so you can read the output directly in code without retries or fragile parsing"* |
| Fireworks | `[UNKNOWN]` — no está en la página de pricing | — | — |
| Groq | `[UNKNOWN]` — no está en la página de modelos | — | — |
| **vLLM self-host** | Sí — backend por defecto **xgrammar**, también outlines y lm-format-enforcer | n/a | https://docs.vllm.ai/en/v0.8.4/features/structured_outputs.html |

**Modelos con soporte confirmado de `json_schema` en DeepInfra:** `gpt-oss-120b`, `gpt-oss-20b`,
`Qwen2.5-72B-Instruct`, `gemma-3-27b-it`, `DeepSeek-V4-Flash`, `Mistral-7B-Instruct-v0.1`.

## 5.3 Qué modelo para qué tarea, al 2026-09-21

| Tarea del PRD | Recomendación de hoy | Precio | Por qué |
|---|---|---|---|
| **Clasificación** (`JV-1` catálogo, `JV-4` verificación de campos, `DP-001`–`DP-007`) | **Llama 3.1 8B** o **Mistral Nemo** en DeepInfra, con `json_schema` strict | $0,02 / $0,04 | Output despreciable; sólo importa el precio de input. Es el más barato verificado **y más barato que Jev** (§7) |
| **Clasificación offline en lote** (catálogo de 25.000 ítems) | Fireworks batch | 50 % del precio serverless `[LISTA]` | `JV-1` es offline por diseño |
| **Generación de copy** (captions, hooks, ángulos, `Improve`/`Regenerate`, `aiExplanation`) | **Nemotron 3.5 Lightning 30B** (Fireworks) o **gpt-oss-120b** | $0,05/$0,20 · $0,15/$0,60 | Output domina el costo; Nemotron es 3× más barato en output que gpt-oss-120b |
| **Portabilidad** | gpt-oss-120b está **al mismo precio en Groq, Fireworks y Together** ($0,15/$0,60) | — | Tres proveedores al mismo precio = el puerto `Llm` de `ADR-009` es real, no teórico |

> **Hallazgo de portabilidad:** que tres gateways independientes coticen `gpt-oss-120b` **al
> centavo idéntico** es la mejor evidencia disponible de que `ADR-009` (gateway
> OpenAI-compatible sobre open-weight) funciona como estrategia. Cambiar de proveedor es una
> variable de entorno y **cuesta cero**.

## 5.4 Self-host con vLLM: dónde está el punto de cruce

**Este es el entregable más valioso de la sección.**

### Precio de la GPU, verificado

| Proveedor | H100 | Modo | `[LISTA]` |
|---|---|---|---|
| **RunPod Pod, Community Cloud** | **$1,99/h** (PCIe) · $2,69/h (SXM) | pod 24×7, **sin SLA** | https://www.runpod.io/pricing |
| RunPod Pod, Secure Cloud | $2,89/h (PCIe) · $3,49/h (SXM) | pod 24×7 | ídem |
| fal.ai | *"as low as"* $1,89/h `[VENDOR]` | — | https://fal.ai/pricing |
| **Modal** | **$0,001097/sec** = $3,949/h `[DERIVADO]` | serverless | https://modal.com/pricing |
| Together | $3,99/h (promo; estándar $5,49) | dedicado | https://www.together.ai/pricing |
| RunPod Serverless | $4,79/h | serverless | https://www.runpod.io/pricing |
| Replicate | $0,001525/sec = $5,49/h | serverless | https://replicate.com/pricing |

### La fórmula

```
Punto de cruce  =  (GPU $/h × 730 h)  ÷  (precio serverless $/M tokens)   [M tokens/mes]
Traducido a carga sostenida:  tokens/mes × 1e6 ÷ (730 × 3600)            [tokens/segundo]
```

### Los cruces, calculados sobre precios verificados `[DERIVADO]`

Tomando la GPU creíble más barata, **RunPod Pod Community H100 PCIe a $1,99/h = $1.453/mes**:

| Contra qué se compara | Cruce en tokens/mes | Cruce en carga sostenida 24×7 |
|---|---|---|
| Clasificación: input de 8B a **$0,02/M** | **72.635 M tok input** | **27.639 tok/s** |
| Generación: output Nemotron 30B a **$0,20/M** | **7.264 M tok output** | **2.764 tok/s** |
| Generación: output gpt-oss-120b a **$0,60/M** | **2.421 M tok output** | **921 tok/s** |

Con un pod **Secure** ($2,89/h = $2.110/mes), los mismos cruces suben a 40.139 · 4.014 · 1.338 tok/s.

### ¿Son alcanzables esas cargas? El anclaje de throughput

Benchmark citable: **DatabaseMart, 2026-08-25**, vLLM sobre H100, 300 requests concurrentes,
100 tok input / 600 tok output — https://www.databasemart.com/blog/vllm-gpu-benchmark-h100

| Modelo | Output tok/s | Total tok/s |
|---|---|---|
| DeepSeek-R1-Distill-Qwen-7B | **6.269,87** | 7.314,85 |
| DeepSeek-R1-Distill-Llama-8B | 5.561,45 | 6.488,36 |
| gemma-2-9b-it | 3.594,38 | 4.193,44 |
| DeepSeek-R1-Distill-Qwen-14B | 3.689,21 | 4.304,07 |
| DeepSeek-R1-Distill-Qwen-32B | 1.191,95 | 1.390,61 |

> **Advertencia sobre este número:** es un benchmark **offline, a saturación, con 300 requests
> concurrentes**. Es un techo teórico, no un régimen de producción. Tráfico real y a ráfagas
> rinde una fracción. Además **ningún modelo de esta tabla es el que se usaría**, y el throughput
> de `gpt-oss-120b` (MoE) en un H100 es **`[UNKNOWN]`**.

### La respuesta

**Para clasificación (input-heavy): el self-host no gana nunca.**
El cruce de **27.639 tokens de input por segundo sostenidos** está en el orden del techo teórico
de prefill de un H100 para un modelo de 8B `[ESTIMACIÓN]` — es decir, habría que correr la GPU
al ~100 % de saturación las 24 horas **sólo para empatar** con los $0,02/M de DeepInfra. En
unidades de producto, a 800 tokens de state por juicio `[ESTIMACIÓN]`, son **90 millones de
juicios al mes**. **No pasa. Conclusión: clasificar siempre por gateway.**

**Para generación (output-heavy): el cruce existe y es alcanzable, pero está lejos.**

```
Cruce contra gpt-oss-120b:  2.421 M tokens de output/mes   [DERIVADO]

Traducido a unidades del PRD, con los supuestos de §3.4:
  400 tok output por sugerencia × 5 sugerencias por save    [ESTIMACIÓN]
  = 2.000 tokens de output por content save facturado

  2.421 M ÷ 2.000 = 1,21 M content saves/mes                [DERIVADO]

  ÷ 100 saves/mes (cuota Growth) ≈ 12.100 usuarios Growth al tope de su cuota
  ÷  20 saves/mes (cuota Starter) ≈ 60.500 usuarios Starter al tope
```

> ### **El punto de cruce: ~12.000 usuarios Growth al tope de cuota, o 2.421 M tokens de output al mes.**
> Por debajo de eso, el gateway gana. Por encima, un H100 propio con vLLM empieza a pagarse.
> A $49/usuario eso son ~$590k de MRR: es una decisión de **Fase 4 o 5**, no de Fase 1.

**`ADR-009` acierta** al decir *"self-hosting con vLLM cuando el volumen lo justifique, no antes"*.
Este documento le pone el número: **el volumen es 2.421 M tokens de output al mes**, y conviene
dejarlo escrito porque sin número esa frase se interpreta como "pronto".

**Matiz honesto sobre el cruce:** los $1,99/h de RunPod son **Community Cloud, sin SLA**. Para
producción hay que usar Secure ($2,89/h), y el cruce sube a **3.516 M tokens/mes**. Y el cálculo
ignora el costo de **operar** las GPUs (guardias, upgrades de vLLM, autoscaling, cold starts),
que no es cero y que `ADR-009` ya identifica como *"un costo fijo que sólo se amortiza con
tráfico"*.

---

# 6. GPU serverless — el driver dominante

## 6.1 Precio por segundo, verificado

**Modal** — https://modal.com/pricing — el único que publica **$/segundo directamente**. `[LISTA]`

| GPU | $/seg `[LISTA]` | $/h `[DERIVADO]` |
|---|---|---|
| B200 | $0,001736 | $6,250 |
| H200 SXM | $0,001261 | $4,540 |
| **H100 SXM5** | **$0,001097** | $3,949 |
| A100 80 GB | $0,000694 | $2,498 |
| A100 40 GB | $0,000583 | $2,099 |
| **L40S** | **$0,000542** | $1,951 |
| A10 | $0,000306 | $1,102 |
| **L4** | **$0,000222** | $0,799 |
| T4 | $0,000164 | $0,590 |

Modal **cobra CPU y RAM aparte** `[LISTA]`: CPU `$0,0000131 / core / sec` con mínimo de 0,125
cores por container; memoria `$0,00000222 / GiB / sec`; volumes `$0,09 / GiB / mo` con 1 TiB/mes
gratis. Free tier: Starter `$30/month` de compute incluido, Team `$100/month`.

**Replicate** — https://replicate.com/pricing — publica $/seg y $/h lado a lado `[LISTA]`

| Hardware | $/seg | $/h |
|---|---|---|
| `gpu-t4` | $0,000225 | $0,81 |
| `gpu-l40s` | $0,000975 | $3,51 |
| `gpu-a100-large` (80 GB) | $0,001400 | $5,04 |
| `gpu-h100` | $0,001525 | $5,49 |
| `gpu-h200` | $0,001525 | $5,49 |
| `cpu` | $0,000100 | $0,36 |

> Replicate **no lista A100 de 40 GB**, y **H200 cuesta exactamente lo mismo que H100** — si el
> workload entra en H200, es upgrade gratis.

**RunPod** — https://www.runpod.io/pricing `[LISTA]`. La página titula *"Per-Second H100, A100,
RTX"* y aclara que factura *"Per second, from worker start to full stop, rounded up to the
nearest second"*, pero **no publica ningún número en $/seg** — sólo tablas horarias.

| GPU | Serverless $/h | Pod Community $/h | Pod Secure $/h |
|---|---|---|---|
| H100 PCIe | $4,79 | **$1,99** | $2,89 |
| H100 SXM | $4,79 | $2,69 | $3,49 |
| A100 80 GB | $2,72 | $1,19 (PCIe) / $1,39 (SXM) | $1,59 |
| L40S | $1,75 | **$0,79** | $1,09 |
| A40 | $1,22 | **$0,35** | $0,49 |
| RTX 4090 | $1,10 | $0,34 | $0,74 |

> **Un pod Community H100 PCIe ($1,99/h) sale ~2,4× menos que el mismo H100 en serverless
> ($4,79/h).** Para trabajos largos y programables — como los fine-tunes LoRA de 15–20 min — esa
> es la diferencia más grande de toda la investigación.
>
> `[UNKNOWN]` **RunPod Flex vs Active**: la tabla de `/pricing` no tiene columnas ni toggle
> Flex/Active. `docs.runpod.io/serverless/pricing` existe pero no contiene tarifas. Circulan dos
> cifras de descuento para Active que **se contradicen entre sí** (40 % y 30 %) y rates de Flex
> distintos de la tabla; ninguna se pudo confirmar en la página. Hay que mirarlo logueado.
> `https://www.runpod.io/pricing/serverless` devuelve **HTTP 404**: no existe.

## 6.2 FLUX.1 [schnell] — `ADR-010`

**Precio por unidad, publicado** `[LISTA]`:

| Proveedor | Precio | URL |
|---|---|---|
| **Replicate** `black-forest-labs/flux-schnell` | **$3,00 / mil imágenes** = **$0,003/imagen** | https://replicate.com/pricing |
| **fal.ai** `fal-ai/flux/schnell` | **$0,003 / megapixel** | https://fal.ai/models/fal-ai/flux/schnell |
| Replicate flux-dev | $0,025/imagen | https://replicate.com/pricing |
| Replicate flux-1.1-pro | $0,04/imagen | ídem |

> ⚠️ **Trampa de redondeo en fal.ai, sin resolver.** La página dice textual: *"Images are billed
> by rounding up to the nearest megapixel."* Una imagen de 1024×1024 son **1,048 MP**, que
> redondeado hacia arriba es **2 MP = $0,006/imagen, el doble**. **`[UNKNOWN]` cuál se cobra
> realmente.** Hay que tirar una request y mirar la factura (experimento E-3, §9). Es el tipo de
> cosa que duplica el COGS sin aparecer en ningún doc.

> ⚠️ **Together ya no ofrece FLUX.1 [schnell].** Su catálogo migró a FLUX.2: `[dev]` a
> $0,0154/imagen, `[pro]` a $0,03/imagen `[LISTA]`. El más barato es **5× Replicate**.
> **Together queda descartado para `ADR-010`.**

**Comparación con GPU cruda**, asumiendo 5 s/imagen `[ESTIMACIÓN]`:

| Opción | $/imagen | |
|---|---|---|
| **Replicate flux-schnell (precio por unidad)** | **$0,003** | `[LISTA]` — sin riesgo de latencia |
| fal.ai flux/schnell | $0,003 (o $0,006 si redondea) | `[LISTA]` + `[UNKNOWN]` |
| Modal H100 crudo a 5 s | ~$0,0055 + CPU/RAM | `[DERIVADO + ESTIMACIÓN]` |
| RunPod Serverless H100 a 5 s | ~$0,0067 | `[DERIVADO + ESTIMACIÓN]` |
| Replicate H100 crudo a 5 s | ~$0,0076 | `[DERIVADO + ESTIMACIÓN]` |

> **Pagar por imagen en Replicate ($0,003) sale más barato que alquilar el H100 crudo de la
> propia Replicate para el mismo trabajo (~$0,0076).** Ellos absorben el cold start, el batching
> y el riesgo de latencia. **Alquilar GPU cruda para schnell sólo conviene con utilización alta y
> constante, y el número a vencer es $0,003 — no el $/h de la GPU.**

**`[UNKNOWN]` — latencia de FLUX.1 [schnell] en H100 de una sola GPU.** Lo que sí hay:
- **RTX 4090: `"2.86s / Image"`** mínimo y **`"5.45 seconds"`** promedio, 1024×1024, 4 steps,
  Euler + Simple — https://blog.salad.com/flux1-schnell/ `[LISTA]`
- **8× A100 con Ulysses:** *"the generation of a 1024px image takes only 0.82 seconds"* —
  https://github.com/xdit-project/xDiT/blob/main/docs/performance/flux.md `[LISTA]` — pero son
  **8 GPUs**, no transferible
- El blog oficial de PyTorch sobre *"making Flux go brrr on H100s"* publica sus resultados
  **sólo como gráficos de imagen**; lo único textual es *"~2.5x speedup"*, sin baseline. Inútil.

→ Usar los **5,45 s de la 4090 como cota superior conservadora** y **medirlo en H100** antes de
comprometer arquitectura (experimento E-4, §9).

## 6.3 Fine-tune LoRA del influencer — `ADR-010`

`PRD.md` línea 1517: *creación del influencer: **250 créditos**, ~15–20 min*. `ADR-010` lee eso
correctamente como un **fine-tune LoRA**. Costo de **una corrida de 20 min (1.200 s)**:

| Opción | Costo/run | Procedencia |
|---|---|---|
| RunPod Pod Community L40S ($0,79/h) | **~$0,26** | `[DERIVADO]` |
| Modal L40S ($0,000542/s) | ~$0,65 + CPU/RAM | `[DERIVADO]` |
| **RunPod Pod Community H100 PCIe ($1,99/h)** | **~$0,66** | `[DERIVADO]` |
| Modal A100 80 GB | ~$0,83 + CPU/RAM | `[DERIVADO]` |
| Modal H100 | ~$1,32 + CPU/RAM | `[DERIVADO]` |
| RunPod Serverless H100 | ~$1,60 | `[DERIVADO]` |
| Replicate A100 80 GB | ~$1,68 | `[DERIVADO]` |
| Replicate H100 | ~$1,83 | `[DERIVADO]` |
| **fal.ai FLUX LoRA fast training** | **$2,00 fijo** | **`[LISTA]`** — *"Your request will cost $2 per training run (scales linearly with steps)."* — https://fal.ai/models/fal-ai/flux-lora-fast-training |

> **fal a $2/run es 3× un pod Community de RunPod, pero es el único número publicado como
> precio y no estimado por mí**, y no obliga a mantener el training script. La diferencia
> absoluta es ~$1,35/run: por debajo de ~1.000 fine-tunes/mes, la ingeniería que se ahorra vale
> más que los $1.350.

`[UNKNOWN]`: precio de LoRA training de FLUX en Replicate — no aparece en `/pricing`.

## 6.4 Generación de video — **de dónde sale el driver dominante**

`PRD.md` línea 1552: el selector de modelo de la UI dice **`Kling v3 Pro`**, duración 5 s o 10 s,
60 créditos.

**`[UNKNOWN]`: no encontré precio publicado para "Kling v3 Pro" con ese nombre exacto.** Lo más
cercano verificado es **Kling 2.5 Turbo Pro**, y lo uso como ancla declarándolo:

| Modelo | Precio `[LISTA]` | URL |
|---|---|---|
| **Kling 2.5 Turbo Pro (fal.ai)** | **$0,07 / segundo** (*"14 seconds"* por dólar) | https://fal.ai/pricing |
| Wan 2.5 (fal.ai) | $0,05 / segundo | ídem |
| Veo 3 (fal.ai) | $0,40 / segundo | ídem |
| Ovi (fal.ai) | $0,20 / video | ídem |
| `wavespeedai/wan-2.1-i2v-480p` (Replicate) | $0,09 / segundo | https://replicate.com/pricing |
| `wavespeedai/wan-2.1-i2v-720p` (Replicate) | $0,25 / segundo | ídem |

```
Video de 10 s con Kling 2.5 Turbo Pro:  10 × $0,07 = $0,70    [DERIVADO]
Video de  5 s:                           5 × $0,07 = $0,35    [DERIVADO]
```

### El hallazgo: el crédito del PRD no está calibrado contra el costo

| Operación | Créditos (PRD) | Costo real `[DERIVADO]` | **$/crédito** |
|---|---|---|---|
| Imagen (FLUX schnell) | 4 | $0,0030 | **$0,00075** |
| Video 5 s (Kling 2.5 TP) | 60 | $0,3500 | **$0,00583** |
| **Video 10 s (Kling 2.5 TP)** | **60** | **$0,7000** | **$0,01167** |
| Influencer (LoRA, fal) | 250 | $2,0000 | **$0,00800** |

> **Un crédito gastado en video de 10 s cuesta 15,6× uno gastado en imagen. Y un video de 10 s
> cuesta exactamente lo mismo en créditos que uno de 5 s, pagando el doble.**
>
> El PRD hereda el tarifario de Fastlane sin verificar que siga el costo. **Es un defecto de
> diseño de producto, no de infraestructura**, y es la palanca de mayor retorno de todo este
> documento. Dos arreglos posibles, ambos fuera del alcance de `P1-INFRA-001`:
> 1. **Cobrar el video de 10 s a 120 créditos** (el doble que el de 5 s), que es lo mínimo
>    para que la cuota no sea arbitraria.
> 2. **Recalibrar la escala entera** contra $/crédito, fijando un techo de COGS por plan.
>
> Cualquiera de los dos exige tocar `PRD.md` §16.2 — **hay que abrir una OQ**, no cambiarlo
> desde esta tarea.

---

# 7. TypeSafe / Jev — verificación y comparación

## 7.1 ¿Sigue vigente lo que registra `EVAL-JEV.md`? **Sí, al centavo.**

`EVAL-JEV.md` (línea 55) registra: *"**$0.042 por millón de tokens de entrada, salida gratis**"*
y (línea 70) *"**Jev es text-only. Sin imagen, sin audio, sin video.**"*

**Verificado contra https://docs.typesafe.ai/models.md el 2026-09-21** — `[LISTA]`:

| Aspecto | Valor verificado hoy | ¿Cambió respecto de `EVAL-JEV.md`? |
|---|---|---|
| Precio | **`$42 / $0.042`** por mil millones / millón de tokens de input; **output gratis** | **No. Idéntico.** |
| Modalidad | *"Text only. String, JSON object, or array of text values. No image, audio, or video input."* | **No. Confirmado textualmente.** |
| Versión | **jev-1.13.0**; alias `jev-latest` y `jev-preview`, ambos apuntando a 1.13.0 | No |
| Contexto | *"64k tokens per request; 32k tokens for `state` plus the longest question"* | **Dato nuevo**, no estaba en `EVAL-JEV.md` |
| Rate limits | **250.000 tokens/segundo · 1.200 requests/minuto** | **Dato nuevo.** `EVAL-JEV.md` riesgo **R2** decía *"latencia sin documentar"* — sigue sin documentarse, pero **el throughput sí está publicado ahora** |
| Endpoint | `POST /v1/systemone`, con el campo `model` seleccionando versión | — |

**`EVAL-JEV.md` no necesita corrección de precio.** Sí se le pueden agregar dos datos nuevos
(contexto de 64k y los rate limits publicados) cuando alguien lo toque — **no lo hago desde esta
tarea**, que sólo escribe este archivo.

## 7.2 La comparación que `EVAL-JEV.md` no hizo, y que invierte su conclusión de costo

`EVAL-JEV.md` línea 55 argumenta: *"Lo nuevo no es la clasificación: es el **precio por
decisión**"*, y línea 149 reconoce honestamente que el múltiplo *"depende del modelo que elijan
— hay que medirlo, no asumir el 200x/400x del fabricante"*.

**Medido. El resultado no favorece a Jev.**

Un juicio de clasificación típico: **800 tokens de state + ~10 tokens de salida** `[ESTIMACIÓN]`.

| Opción | Cálculo | **$/juicio** | Procedencia |
|---|---|---|---|
| **Mistral Nemo (DeepInfra)** | 800×$0,019/M + 10×$0,03/M | **$0,0000155** | `[DERIVADO]` sobre `[LISTA]` |
| **Llama 3.1 8B (DeepInfra)** | 800×$0,02/M + 10×$0,04/M | **$0,0000164** | `[DERIVADO]` sobre `[LISTA]` |
| **Jev 1.13** | 800×$0,042/M + output gratis | **$0,0000336** | `[DERIVADO]` sobre `[LISTA]` |
| Nemotron 3.5 30B (Fireworks) | 800×$0,05/M + 10×$0,20/M | $0,0000420 | `[DERIVADO]` |
| gpt-oss-120b (3 gateways) | 800×$0,15/M + 10×$0,60/M | $0,0001260 | `[DERIVADO]` |

> ### **Jev es ~2,05× MÁS CARO por juicio que Llama 3.1 8B en DeepInfra, y ~2,17× más caro que Mistral Nemo.**
>
> La razón es estructural y vale entenderla: la ventaja de Jev es que **el output es gratis**,
> pero en clasificación **el output es ~10 tokens** — es decir, la ventaja aplica sobre el
> término que ya era despreciable. Lo único que importa es el precio de input, y ahí Jev cobra
> **$0,042/M contra los $0,02/M de un 8B open-weight**.
>
> La comparación implícita de `EVAL-JEV.md` (48× más barato que GPT-5.6 Terra a $2,00/M input)
> es cierta **contra un modelo frontier**. Contra el open-weight barato que `ADR-009` ya eligió
> como estrategia, **la ventaja de precio desaparece y se invierte.**

**Qué NO dice esto.** No dice que Jev no sirva. Dice que **el argumento de costo no se sostiene
y hay que apoyar la decisión en otra cosa**:
- **probabilidades calibradas en un solo pasaje**, que un LLM con `json_schema` no da gratis
- **1.200 req/min y 250k tok/s publicados** `[LISTA]`, que es un compromiso de capacidad que los
  gateways no publican
- **calidad en la tarea**, que `EVAL-JEV.md` §25.4 ya plantea medir y que sigue sin medirse

Y refuerza la decisión que ya está tomada: **el puerto `Judgment` de `EXT-008`/`ADR-009` es lo
correcto**, precisamente porque permite correr `LlmJudgmentAdapter` contra un 8B a mitad de
precio y usar Jev sólo donde la calibración lo justifique.

## 7.3 Costo real de la capa de Judgment en este producto

`JV-1` clasifica el catálogo de tendencias: **25.000+ ítems, actualizados a diario**
(`PRD.md` F-041).

```
Supuesto [ESTIMACIÓN]: 400 tok de state por ítem (caption + hashtags + ocrText + métricas)
Pasada completa = 25.000 × 400 = 10 M tokens de input

  Jev 1.13:                    10 × $0,042 = $0,42 por pasada    [DERIVADO]
  Llama 3.1 8B (DeepInfra):    10 × $0,02  = $0,20 por pasada    [DERIVADO]
  Fireworks batch (50 % off):                ~$0,10 por pasada    [DERIVADO]
```

**Menos de $0,50 por reclasificar el catálogo entero, con cualquiera de los tres.** Y es un
**costo compartido**, no por usuario. La capa de Judgment **no es un driver de costo** en este
producto — a ninguno de los dos precios. Decidir Jev vs LLM por precio es optimizar el término
equivocado.

---

# 8. Tabla final: costo por usuario/mes y margen bruto

## 8.1 Supuestos declarados

Esta tabla mezcla `[LISTA]` y `[ESTIMACIÓN]`. **Los supuestos son estos y están todos en §9
como experimentos pendientes:**

| Supuesto | Valor | Etiqueta |
|---|---|---|
| Proveedor de video | Kling 2.5 Turbo Pro en fal.ai, $0,07/s | `[LISTA]` (pero el PRD nombra "Kling v3 Pro" — §6.4) |
| Proveedor de imagen | Replicate flux-schnell, $0,003/imagen | `[LISTA]` |
| Proveedor de LoRA | fal.ai, $2,00/run | `[LISTA]` |
| Storage/egress | R2 Standard | `[LISTA]` |
| LLM | gpt-oss-120b, $0,15/$0,60 | `[LISTA]` |
| Render | CCX33 a €0,0237/vCPU-h, 60 s de 1 vCPU por render | `[LISTA]` + `[ESTIMACIÓN]` |
| Ratio de la cola de Blitz | 5 sugerencias generadas por save aceptado | **`[ESTIMACIÓN]`** |
| Tamaño de preview | 10 MB | **`[ESTIMACIÓN]`** |
| Storage acumulado | 500 MB/usuario | **`[ESTIMACIÓN]`** |
| Uso de créditos | **caso caro**: todos en video de 10 s | escenario, no predicción |

## 8.2 Caso caro — todos los créditos en video de 10 s

| Concepto | Free | Starter | Growth | Pro |
|---|---|---|---|---|
| **Precio del plan** | **$0** | **$29** | **$49** | **$149** |
| Créditos | 10 | 250 | 500 | 2.000 |
| Content saves | `[UNKNOWN]` | 20 | 100 | ilimitado `[UNKNOWN]` |
| **GPU — video** | $0,12 | **$2,92** | **$5,83** | **$23,33** |
| CPU de render (AX42-1) | $0,00 | $0,03 | $0,16 | `[UNKNOWN]` — sin cap |
| Tokens de LLM | $0,00 | $0,04 | $0,21 | `[UNKNOWN]` — sin cap |
| Egress (R2) | $0,00 | $0,00 | $0,00 | $0,00 |
| Storage (R2) | $0,00 | $0,01 | $0,01 | $0,02 |
| OCR (self-host) | $0,00 | $0,00 | $0,00 | $0,00 |
| **COGS variable total** | **$0,12** | **$3,00** | **$6,21** | **≥$23,35** |
| **Margen bruto variable** | **−$0,12** | **$26,00 (89,7 %)** | **$42,79 (87,3 %)** | **≤$125,65 (≤84,3 %)** |

EUR convertido a USD a ~1,17 `[ESTIMACIÓN]` — el tipo de cambio es un supuesto más, y afecta
sólo a las dos filas de cómputo, que son las más chicas de la tabla.

## 8.3 Caso barato — todos los créditos en imágenes

| Concepto | Free | Starter | Growth | Pro |
|---|---|---|---|---|
| **GPU — imagen** | $0,01 | $0,19 | $0,38 | $1,50 |
| Todo lo demás (render + LLM + storage) | $0,00 | $0,08 | $0,38 | `[UNKNOWN]` |
| **COGS variable total** | **$0,01** | **$0,27** | **$0,76** | **≥$1,50** |
| **Margen bruto variable** | **−$0,01** | **$28,73 (99,1 %)** | **$48,24 (98,4 %)** | **≤$147,50 (≤99,0 %)** |

## 8.4 Lo que estas tablas NO incluyen

- **Costo fijo de infraestructura: ~€357/mes de piso** (§3.3). Con 100 usuarios pagos eso son
  €3,57/usuario y **cambia el margen materialmente**; con 1.000, €0,36 y se diluye.
- **Warmed Accounts ($100/mes/cuenta + $1,50/post):** es **trabajo humano**, un pass-through
  con un costo que el PRD no publica. **`[UNKNOWN]`**, y es el único renglón con riesgo de
  margen negativo si el costo humano supera el precio.
- **Human UGC videos** (100 en Growth, 2.000+ en Pro) y el **catálogo de 25.000 trending videos**:
  `PRD.md` líneas 3391, 3662 y 3920 los marcan como *"requieren estrategia propia de contenido
  licenciado"*, sin derechos ni método resueltos. **`[UNKNOWN]` por construcción** — es una
  negociación de licencias, no un precio de lista. Ver §9.
- Stripe/pagos, soporte, y el costo de los rechazos en Blitz del plan **Free**.

## 8.5 La respuesta que esta tarea existe para dar

> ## El driver que domina es la **generación de video en GPU**.
>
> **$23,33 por usuario Pro al mes** en el caso caro — **15,7 % del precio del plan** — contra
> **menos de $0,50 sumando absolutamente todo lo demás**. Es **dos órdenes de magnitud** de
> diferencia.
>
> Y el corolario que importa más que el número: **la cuota que dispara ese costo (AI Studio
> credits) está tarifada en el PRD con una escala que no sigue al costo** — un crédito de video
> cuesta 15,6× uno de imagen, y un video de 10 s cuesta lo mismo en créditos que uno de 5 s
> pagando el doble. **La palanca de mayor retorno no es técnica: es recalibrar los créditos.**

---

# 9. Lo que quedó UNKNOWN, y el experimento que lo resuelve

## 9.1 Bloqueantes de arquitectura

| # | UNKNOWN | Por qué importa | Experimento |
|---|---|---|---|
| **E-1** | **¿R2 + Workers está permitido hoy para servir video en Free/Pro/Business?** Tres fuentes oficiales de Cloudflare se contradicen (§4.4) | Es el supuesto de `ADR-006`. Si la respuesta es no, hay que usar Stream (45× más caro) o mudarse a B2+bunny | **Pedir confirmación por escrito a Cloudflare**, citando el blog de 2023 contra los Service-Specific Terms y las docs de ago-2026. No es un experimento técnico: es una pregunta comercial, y hay que hacerla **antes** de `P1-INFRA-004` |
| **E-2** | **Segundos de CPU por render**, por formato (slideshow / wall-of-text / green-screen / video-hook) | Es el supuesto de todo §3.2, y decide el sizing del pool de `services/render` | Renderizar 20 piezas de cada formato en un CCX33 y medir `time`. Depende de que exista `services/render` — es un sub-entregable natural de `P1-RENDER-*` |
| **E-3** | **fal.ai: ¿1024×1024 se cobra como 1 MP o como 2 MP?** *"rounding up to the nearest megapixel"* | Duplica o no el COGS de imagen | Una sola request de 1024×1024 y leer la factura. **Cuesta $0,006 y cierra la pregunta.** El más barato de la lista |
| **E-4** | **Latencia de FLUX.1 [schnell] en H100 de una GPU.** Sin fuente citable con metodología (§6.2) | Decide si conviene el precio por unidad ($0,003) o GPU cruda | Correr schnell 4 steps 1024×1024 en un pod RunPod H100 ($1,99/h) y medir. Cota superior actual: 5,45 s (RTX 4090, SaladCloud) |
| **E-5** | **Precio de "Kling v3 Pro"**, el modelo que el PRD nombra literalmente (§6.4) | Es **el input del driver dominante**. Todo §8 se apoya en Kling 2.5 Turbo Pro como sustituto | Buscarlo en fal/Replicate/proveedor directo. Si v3 cuesta más que $0,07/s, **las tablas de §8 son optimistas** y el margen de Pro cae |

## 9.2 Cuotas del PRD sin número

| # | UNKNOWN | Fuente | Qué haría falta |
|---|---|---|---|
| **E-6** | **Cuota de storage agregado por plan.** `PRD.md` §16.2 dice *"por plan"* sin número | PRD §16.2 | Sin esto no se puede acotar el costo de storage por usuario. Está en la lista de gaps del propio PRD (línea 3670). **Es una decisión de producto, no una medición** |
| **E-7** | **Cap diario de swipes de Blitz por plan** | PRD línea 3670, explícito: *"cap diario de swipes por plan"* falta | Acota el costo de los rechazos, sobre todo en el plan **Free**, que tiene acceso a Blitz y no paga |
| **E-8** | **Qué significa "Unlimited content saves" en Pro** | PRD §16.1 | Sin un cap, **el COGS de Pro no tiene techo**. Hay que medir el p95 real y decidir si hay fair-use. Es el mayor riesgo de margen de la tabla §8 |
| **E-9** | **"Limited content" del plan Free** | PRD §16.1 | El Free consume GPU y render sin ingreso |
| **E-10** | **Ratio de aceptación de Blitz** (§1.4) | no está en el PRD | Multiplica los drivers de render y de tokens. **Se mide con el evento de analytics del PRD §18** en cuanto haya tráfico. Hoy `[ESTIMACIÓN] = 20 %` |

## 9.3 Costos que no son precios de lista

| # | UNKNOWN | Nota |
|---|---|---|
| **E-11** | **Derechos y costo del catálogo de 25.000 trending videos y de los 2.000+ human UGC videos** | `PRD.md` líneas 3391, 3662, 3920 y §7 del plan lo marcan como riesgo legal sin resolver. **No hay precio de lista: es una negociación.** Es el UNKNOWN más grande del modelo y el plan ya lo trata como track propio |
| **E-12** | **Costo humano real de Warmed Accounts** ($100/mes + $1,50/post de precio) | Es el único renglón con riesgo de **margen negativo**. Precio conocido, costo no |
| **E-13** | **Costo de operar GPUs propias** (guardias, vLLM, autoscaling, cold starts) | Entra en el cruce de §5.4 y lo empuja hacia arriba. No cuantificado |

## 9.4 Precios que el proveedor no publica

| # | UNKNOWN | Evidencia |
|---|---|---|
| **E-14** | **fal.ai, GPU cruda por segundo (H100/A100)** — **no es público**. `fal.ai/docs/documentation/compute/pricing` dice textual: *"Contact the fal team or check the dashboard for current per-hour rates."* Sólo existe el `$1,89/h` de H100 con el hedge *"as low as"* | **Hay que hablar con ventas** |
| **E-15** | **RunPod Flex vs Active**: los descuentos publicados se contradicen entre sí (40 % vs 30 %) y ninguno está en `/pricing`. `runpod.io/pricing/serverless` da **HTTP 404** | Requiere consola logueada |
| **E-16** | **Soporte de `json_schema` en Fireworks y Groq** — no está en sus páginas de pricing ni de modelos | Chequear sus docs de API. **Bloquea a esos dos gateways para el `LlmJudgmentAdapter`** hasta confirmarlo (`ADR-009` lo exige) |
| **E-17** | **Egress de DigitalOcean Managed DB y de Crunchy Bridge** — no lo publican en sus páginas de pricing. Precio de IPv4 para **dedicados** Hetzner (las tablas dicen *"excl. IPv4"* y la página de addons no lo lista). Precios de la **Server Auction** de Hetzner (JS no renderiza; sólo se vio el filtro 0–850 €) y de Ubicloud/Autobase | Afecta a `P1-INFRA-002`/`P1-INFRA-003`, no al orden de los drivers. Lo demás de Postgres quedó verificado — ver §3.3 |
| **E-18** | **LoRA training de FLUX en Replicate** — no aparece en `/pricing` | — |
| **E-19** | **Throughput de `gpt-oss-120b` (MoE) en un H100 con vLLM** | Es el denominador del cruce de §5.4. El benchmark disponible sólo cubre modelos densos de 7–32B |

---

# 10. Qué habría que revisar en el plan

Ninguna de estas es una corrección que esta tarea pueda aplicar: `P1-INFRA-001` escribe este
archivo y nada más. Quedan como entrada para quien tome `IMPLEMENTATION-PLAN.md` y `PRD.md`.

| Documento | Qué revisar | Por qué |
|---|---|---|
| **Plan §5** | **El orden de los drivers está invertido.** Egress y CPU de render son #1 y #2; medidos son #4 y #6. GPU es #3; medido es **#1 por dos órdenes de magnitud** | §2 de este documento |
| **`ADR-006`** | **La justificación es falsa, aunque la decisión sea correcta.** *"En un producto de video el tráfico de salida domina la factura"* no aplica a un producto que publica nativo en TikTok/Instagram. Además falta el riesgo real: los términos de Cloudflare para servir video fuera de Enterprise | §4.3, §4.4 |
| **`ADR-012`** | **La afirmación no se verifica.** *"El costo por minuto de audio a escala de catálogo hace que las APIs de transcripción sean el segundo driver de costo"* — transcribir el catálogo **entero** cuesta **$37,50** a precio de lista de OpenAI. Diferirlo sigue bien por `D-03`; self-hostearlo por precio, no | §3.5 |
| **`ADR-013`** | **Tres correcciones.** (a) **Hetzner subió la línea CCX +113 % a +173 % el 15-jun-2026**: el múltiplo contra AWS cayó de ~3,5× a **1,4–1,6×** (c7i.2xlarge $0,357/h vs CCX33 $0,2612/h `[LISTA]`), así que *"por core barato"* ya no es el argumento fuerte — **el argumento fuerte es el tráfico: €1/TB contra el egress de AWS**. (b) **Un vCPU de Hetzner Cloud es un thread, no un core** (FAQ oficial): el sizing de `services/render` hay que hacerlo sobre cores físicos. (c) Por (b), **el render debería ir a un dedicado AX42-1** (8 cores, tráfico ilimitado, €97,30) y no a un CCX33 (~4 cores, €138,49). Re-comparar antes de `P1-INFRA-002` | §3.2 |
| **`ADR-003`** | **Hetzner no ofrece Postgres gestionado.** Con `ADR-003` (*"PostgreSQL como única base de datos"*) + `ADR-013` (Hetzner), Postgres queda self-hosted por omisión — y `P1-INFRA-003` exige backups con **restore probado**. Conviene que esa combinación sea una decisión escrita y no un resultado accidental de dos ADRs que no se miran entre sí | §3.3 |
| **`ADR-009`** | **Acierta, y ahora tiene número:** el cruce de self-host está en **2.421 M tokens de output/mes**. Vale escribirlo, porque *"cuando el volumen lo justifique"* sin número se lee como "pronto" | §5.4 |
| **`ADR-010`** | **Se confirma**, con dos datos nuevos: **Together ya no ofrece FLUX.1 [schnell]** (migró a FLUX.2, 5× más caro), y **el precio por unidad de Replicate ($0,003/img) gana a alquilar GPU cruda** para este workload | §6.2 |
| **`ADR-011`** | **Se confirma, pero por el motivo que el plan ya da (calidad), no por costo.** El ahorro de self-hostear OCR es de **$0,11 por alta, una vez** | §3.5 |
| **`EVAL-JEV.md`** | El precio **no cambió** ($0,042/M input, output gratis, text-only — confirmado textual hoy). Pero la comparación de costo contra **open-weight barato** invierte la conclusión: **Jev es ~2× más caro por juicio que Llama 3.1 8B en DeepInfra**. La decisión sobre Jev hay que apoyarla en calibración y capacidad, no en precio | §7.2 |
| **`PRD.md` §16.2** | **La escala de créditos no sigue al costo** (15,6× entre video e imagen; 10 s al mismo precio que 5 s). **Abrir una OQ** | §6.4 |
| **`PRD.md` §16.1** | **"Unlimited content saves" en Pro deja el COGS sin techo.** Es el mayor riesgo de margen del modelo | §9.2, E-8 |

---

## Registro de fuentes

Todas consultadas el **2026-09-21**.

**Storage y egress:** developers.cloudflare.com/r2/pricing · developers.cloudflare.com/stream/pricing ·
developers.cloudflare.com/r2/buckets/public-buckets · cloudflare.com/terms ·
cloudflare.com/service-specific-terms-application-services · blog.cloudflare.com/updated-tos ·
aws.amazon.com/s3/pricing + API oficial de pricing de AWS (`publicationDate` 2026-09-18 / 2026-09-16) ·
aws.amazon.com/cloudfront/pricing/pay-as-you-go · backblaze.com/cloud-storage/pricing ·
bunny.net/pricing · bunny.net/storage

**GPU:** modal.com/pricing · runpod.io/pricing · replicate.com/pricing · fal.ai/pricing ·
fal.ai/models/fal-ai/flux/schnell · fal.ai/models/fal-ai/flux-lora-fast-training · together.ai/pricing ·
blog.salad.com/flux1-schnell · github.com/xdit-project/xDiT

**LLM:** deepinfra.com/pricing · docs.deepinfra.com/chat/structured-outputs ·
docs.fireworks.ai/serverless/pricing · fireworks.ai/pricing · console.groq.com/docs/models ·
together.ai/pricing · docs.together.ai/docs/json-mode · docs.vllm.ai/en/v0.8.4/features/structured_outputs ·
databasemart.com/blog/vllm-gpu-benchmark-h100 (benchmark fechado 2026-08-25)

**Judgment:** docs.typesafe.ai/models.md · docs.typesafe.ai/llms.txt

**Cómputo:** docs.hetzner.com/general/infrastructure-and-availability/price-adjustment (ID GE-D9256) ·
docs.hetzner.com/cloud/servers/faq (thread vs core) · docs.hetzner.com/robot/general/traffic ·
docs.hetzner.com/cloud/billing/faq · docs.hetzner.com/cloud/servers/primary-ips/overview ·
hetzner.com/cloud/general-purpose · hetzner.com/dedicated-rootserver/ax42 · hetzner.com/dedicated-rootserver/ax102 ·
feed oficial de precios de EC2 us-east-1 (`hawkFilePublicationDate` 2026-09-18) ·
vercel.com/pricing · developers.cloudflare.com/workers/platform/pricing

**Postgres:** neon.com/pricing · supabase.com/pricing · digitalocean.com/pricing/managed-databases ·
crunchydata.com/pricing

**ASR, OCR, transcode:** cloud.google.com/vision/pricing · deepgram.com/pricing ·
developers.openai.com/api/docs/pricing · aws.amazon.com/mediaconvert/pricing · mux.com/pricing/video

> **Nota de método recurrente:** las tablas de precios de Hetzner, AWS EC2, AWS S3 y AWS
> CloudFront se inyectan por JavaScript y **no son fetcheables** — en varios casos vuelven
> vacías incluso en un navegador real. Los números de esos cuatro proveedores salen de sus
> **feeds y páginas de documentación oficiales**, que son la misma fuente que alimenta la página
> visual y que además traen fecha de publicación. Está anotado en cada sección.
