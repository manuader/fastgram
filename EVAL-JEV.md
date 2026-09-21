# Evaluación: ¿incorporar Jev (TypeSafe AI) a FastGram?

**Fecha:** 2026-09-21 · **Autor:** arquitectura · **Estado:** decisión pendiente
**Veredicto corto:** sí hay 2–3 encajes reales, pero **no conviene adoptarlo todavía**. La acción correcta hoy cuesta casi nada y no compromete a nada. Detalle en §8.

> **Estado: incorporado al PRD (2026-09-21).** Las recomendaciones de este documento están integradas como decisión **D-05** (§2.7 del PRD), el puerto `Judgment` (§9.15) y la sección **§25 — Judgment Layer**, con los puntos de decisión `DP-001`…`DP-007` y las features `JV-1`…`JV-6`.
>
> **Nomenclatura:** los puntos de decisión pasaron de `D1`…`D12` a **`DP-001`…`DP-012`** para no colisionar con las decisiones de producto `D-01`…`D-05` del PRD. Este documento ya usa la nomenclatura nueva.

---

## 0. Datos del proyecto y una corrección al encuadre

Los campos del pedido venían como plantilla. Los completo con lo que hay:

| Campo | Realidad |
|---|---|
| **Nombre** | FastGram |
| **Qué hace** | Clon funcional de Fastlane: convierte una URL o un perfil social en contenido short-form generado por IA, lo programa y lo publica en TikTok, Instagram Reels, YouTube Shorts, LinkedIn y Reddit. Para founders, e-commerce, creadores, agencias. |
| **Stack** | **No definido.** El PRD deja la tecnología libre a propósito y sólo fija comportamiento. |
| **Etapa** | **Spec. Pre-MVP. Cero código.** |
| **Restricciones** | Presupuesto no declarado. El PRD sí fija cuotas duras (content saves, swipes diarios, créditos, rate limits) y tiempos (builds de 30 s–2 min, polling cada 10 s). Privacidad: perfiles de marca, **contenido de terceros** y tokens OAuth. |

### El pedido dice "explorá el código antes de proponer nada". No hay código.

El repo completo es:

```
PRD.md                       3.668 líneas
docs/features/demo/*.mp4     9 videos de referencia
```

Sin `package.json`, sin `src/`, sin Dockerfile, sin git. Esto **cambia la evaluación entera** y conviene decirlo antes que nada:

1. **No hay baseline.** No existe ninguna llamada a LLM que medir, ningún if-else frágil que reemplazar, ningún costo actual que comparar. Cualquier cifra de "ahorro" que yo pusiera acá sería inventada. Todo lo que sigue se deriva de **volúmenes especificados en el PRD**, no medidos.
2. **Pero el momento es bueno para decidir la forma, no el proveedor.** Meter una capa de abstracción cuando no hay código cuesta cero; retrofitearla después cuesta caro. Ahí está el valor real de esta evaluación.
3. **El inventario de §3 es prospectivo.** Señala dónde el PRD *especifica* decisiones, no dónde el código las toma hoy.

---

## 1. Qué es Jev, en términos de este proyecto

Jev (`jev-1.13.0`) es un *System One model*: recibe un estado en lenguaje natural y un conjunto de preguntas con respuestas definidas de antemano, y devuelve **la respuesta elegida más su distribución de probabilidad**, en un solo pasaje. No genera texto y no razona en pasos.

En FastGram esto ocupa un lugar que hoy **no tiene ocupante**: el PRD describe decenas de decisiones semánticas —¿este post de Reddit es una oportunidad de venta? ¿este video en tendencia sirve para esta marca? ¿este campo del perfil está respaldado por la evidencia?— y para casi todas dice *qué* debe pasar pero no *con qué*. Hoy sólo hay tres opciones implícitas: LLM con salida estructurada (caro por volumen), reglas por keywords (frágiles con datos desordenados), o el usuario a mano (no escala). Jev es una cuarta: barata, tipada y con probabilidad utilizable como umbral.

Lo que **no** reemplaza: todo lo que el producto genera —captions, hooks, ángulos, la explicación de "Why This Content"— sigue siendo trabajo de un LLM. Jev decide y puntúa; el LLM escribe.

---

## 2. Por qué es novedoso — y dónde eso sí importa acá

### Lo que habilita

Lo nuevo no es la clasificación: es el **precio por decisión**. Documentado: **$0.042 por millón de tokens de entrada, salida gratis**. El cookbook oficial de re-ranking reporta 1.200 llamadas reales por **$0,0645** — unos **$0,00005 por juicio**. A ese precio se vuelve razonable evaluar *cada fila, cada evento, cada item del catálogo*, que con un LLM se descarta por costo antes de intentarlo.

Y la salida tipada con distribución permite algo que un LLM parseado no da limpio: **umbrales explícitos**. `>0.9 actúo solo, 0.5–0.9 pido confirmación, <0.5 escalo`.

### ¿FastGram tiene ese problema? Parcialmente, y conviene ser exacto

**Sí, en dos lugares, y son justamente los dos huecos que el PRD deja marcados:**

- **Librería de trending (`F-041`).** El PRD la marca como riesgo abierto: 25.000+ videos etiquetados por nicho, "updated daily", y dice explícitamente que el clon *necesita su propia estrategia de ingestión*. Eso es clasificación masiva y recurrente. Es el caso canónico.
- **Engagement / leads de Reddit (`FR-140`, `AI-013`).** El PRD especifica scoring de leads, priorización y un medidor de riesgo de baneo, pero **no define el motor**. Es scoring de miles de items por workspace y por día.

**No, en el resto.** El bucle principal del producto —Blitz, el Content Studio, el scheduling— está diseñado alrededor de **muestreo ponderado determinístico** (`slideshowWeight`, `remixPercentage`, `angleWeights`, `influencerChance`). Eso no es un problema de IA: es `random()` contra pesos que el usuario controla, y **debe seguir siéndolo** porque es auditable y el usuario espera poder ajustarlo con un slider. Meter un modelo ahí sería regresión, no mejora.

### Una restricción dura que el encuadre del pedido no menciona

**Jev es text-only. Sin imagen, sin audio, sin video.**

FastGram es un producto de video. Todo juicio sobre un asset visual exige convertirlo a texto antes: OCR del overlay, ASR del audio, caption, metadatos. El PRD ya especifica ese pipeline para Brand Sources (`AI-016`, `INT-015`, `INT-016`), así que hay sinergia real — pero es una **dependencia dura**, no un detalle. Sin OCR/ASR, la mitad de los casos de uso interesantes no existen.

---

## 2 bis. Correcciones al contexto del pedido

Verificado contra `docs.typesafe.ai` el 2026-09-21.

| Afirmación del encuadre | Estado |
|---|---|
| System One, no genera texto, tipado + probabilidades, un pasaje | ✅ Correcto |
| Lanzado septiembre 2026 | ✅ Correcto — o sea, **~3 semanas de vida** |
| "70–500 ms de latencia" | ❌ **No aparece en la documentación.** No hay cifras de latencia publicadas. Es claim de marketing sin respaldo en docs. |
| "~100x más rápido y barato" | ⚠️ El fabricante hoy dice **"hasta 200x más rápido y 400x más barato"** (vía la integración de LangChain). Ni una ni otra verificadas de forma independiente. Lo que **sí** es verificable y está documentado es el precio: $0.042/M input, output gratis. |
| "Sin alucinaciones fuera del esquema" | ⚠️ **Matiz importante.** Los docs dicen literalmente: *"Typed output guarantees the interface, not truth."* El esquema se respeta siempre; la respuesta puede estar mal igual. |
| Integración con LangChain | ✅ Confirmada: paquete `langchain-typesafe`, `TypeSafeClassifier` como Runnable, más tres middlewares (routing por tier, selección de skills, gating de riesgo de tools). |

**Datos relevantes que el encuadre no traía:**
- Modelo actual `jev-1.13.0`; alias `jev-latest`, `jev-preview`.
- **Text-only.** Sin entrada de imagen/audio/video.
- Contexto: 64k tokens por request; 32k para `state` + la pregunta más larga.
- Rate limits: 250.000 tokens/s y 1.200 req/min — con aviso de que *"se ajustan dinámicamente"*.
- Tres primitivas: **Choice** (máx. 255 opciones, devuelve distribución + confianza), **Score** (2–10 niveles, valor ponderado por probabilidad), **Noul** (probabilidad 0–1, **sin** confianza separada).
- No entrenan con datos de usuario; **zero data retention** disponible para enterprise (`privacy@typesafe.ai`).
- **Existe una página oficial de "jaggedness"** con debilidades conocidas del modelo. Que el fabricante la publique es buena señal de honestidad, y es material obligatorio antes de diseñar nada. Resumen en §7.

---

## 3. Inventario de puntos de decisión

Recorrido sobre lo que el PRD especifica. `Ubicación` = sección del PRD, no archivo.

### 3.1 Encajes fuertes

| # | Ubicación | Qué decide | Frecuencia estimada | Cómo se resolvería hoy | Costo/latencia |
|---|---|---|---|---|---|
| **DP-001** | `F-041` Trending ingestion | Nicho(s), formato, estilo de hook, aptitud para remix, seguridad de marca — por cada item del catálogo | 25k inicial + ~1k/día (PRD: *"Updated daily"*) | Sin definir. El PRD lo marca como gap. | Offline, sin latencia de usuario |
| **DP-002** | `FR-140` / `AI-013` Lead scoring | ¿Este post de Reddit es una oportunidad? ¿Qué tan fuerte? | Miles/día × workspace | Sin definir | Batch, tolerante a latencia |
| **DP-003** | `FR-140` Ban risk meter | Clasificar cada respuesta como *value-add / sutil / promo directa* | 1 por respuesta enviada | Sin definir | Tiempo real, pero volumen bajo |
| **DP-004** | `AI-016` / `DATA-004` `fieldMeta` | ¿El extracto citado respalda realmente este campo del perfil? → `confidence: high/medium/low` | ~8 campos × cada análisis de marca | Sin definir. **El PRD exige la confianza pero no dice cómo calcularla.** | En el alta: sensible |
| **DP-005** | `FR-050` Blitz | Qué item de trending remixar para *esta* marca | Cada sugerencia encolada (~5 en cola, relleno continuo) | `ownMediaPercentage` + filtro de nicho | Background |
| **DP-006** | `FR-060` Publishing | Traducir el error del proveedor a un `errorCode` estable y neutral | Cada fallo de publicación | if-else sobre strings del proveedor → frágil por diseño | Post-fallo |
| **DP-007** | Nuevo (no está en el PRD) | ¿Esta caption va a ser rechazada o ajustada por la plataforma antes de publicarla? | Cada post programado | **No se hace.** El fallo se descubre después de publicar. | Pre-publicación |

### 3.2 Encajes medios

| # | Ubicación | Qué decide | Nota |
|---|---|---|---|
| DP-008 | `FR-011` Brand Sources | Tipo de cuenta: personal / marca / tienda / creador | Choice simple, volumen bajo |
| DP-009 | `FR-011` edge case | Cohesión temática (*"Your posts cover a lot of ground"*) | El PRD ya pide este juicio explícitamente |
| DP-010 | `FR-010` Onboarding | `businessCategories` desde el perfil analizado | Hoy: el usuario las elige a mano. Autocompletarlas reduce fricción |
| DP-011 | `FR-150` Automations | `failureReason: no_unique_content` — ¿este borrador repite algo ya usado? | **Mejor con embeddings**; Jev sólo para los casos borderline |
| DP-012 | `FR-100` Media Bank | Auto-categorizar uploads (`slideshow-image`, `hook-video`, …) | Hoy: manual. **Pero Jev no ve imágenes** → necesita visión previa. Fit débil |

### 3.3 Donde **no** va (y por qué es importante listarlo)

| Ubicación | Por qué no |
|---|---|
| `FR-055` mezcla de contenido, `angleWeights`, `influencerChance` | Muestreo ponderado determinístico. El usuario lo controla con sliders y espera que sea exacto. Reemplazarlo por un modelo sería **perder** una propiedad. |
| `FR-011.1` detección de plataforma desde URL/handle | Parseo de host. Una regex alcanza y no falla. |
| `FR-140` cálculo del ratio promo/valor | **Aritmética.** Jev está documentado como malo contando. El ratio lo calcula código; Jev sólo aporta la etiqueta por respuesta (DP-003). |
| `FR-060` `minLeadTimeMs`, ventanas, techo de 30 días | **Fechas y aritmética.** Debilidad documentada del modelo. Código. |
| `FR-150` `launchValidation` | Estado y cuotas. Código. |
| Toda generación: captions, hooks, ángulos, `Improve`/`Regenerate`, `aiExplanation` | Jev no genera texto. |

---

## 4. Valor que aporta

> Todas las cifras derivan de **volúmenes del PRD × precio documentado**. Ninguna está medida contra un baseline, porque no hay baseline.

**Ancla de costo** (dato del cookbook oficial, no estimación mía): 1.200 juicios = 1,54 M tokens de entrada = **$0,0645**. ≈ **$0,00005 por juicio**, ≈ **$54 por millón**.

| Dimensión | Estimación | Confianza |
|---|---|---|
| **Costo — DP-001 catálogo** | 25k items × ~1.500 tok = **~$1,60 la carga inicial**; ~$0,06/día el incremental | Alta: precio documentado × volumen del PRD |
| **Costo — DP-002 leads** | 200k juicios/día (100 workspaces × 2k posts) ≈ **$10/día**. A 1.000 workspaces, ~$100/día | Alta en el precio, media en el volumen |
| **Costo vs. LLM** | Hay una diferencia **estructural**: en Jev la salida es gratis y en un LLM se paga. El múltiplo exacto depende del modelo que elijan — **hay que medirlo, no asumir el 200x/400x del fabricante** | ⚠️ Claim no verificado |
| **Latencia** | **No estimable.** No hay cifras publicadas. El "70–500 ms" del encuadre no está en la documentación. Hay que medirlo antes de poner esto en cualquier ruta síncrona | ❌ Sin dato |
| **Confiabilidad** | La salida siempre respeta el esquema → desaparece el parseo defensivo de JSON de LLM. Pero *"typed output guarantees the interface, not truth"*: **el tipo no valida la respuesta** | Alta (documentado) |
| **Escala** | Es el punto fuerte. A 100x volumen, DP-001 y DP-002 siguen costando decenas de dólares/día. Es lo que vuelve viable evaluar *cada* item en vez de una muestra | Media |
| **UX** | El impacto real no es el costo: es **DP-007** (avisar de un problema *antes* de publicar) y **DP-004** (poder decir con honestidad qué campos del perfil son dudosos). Ambas son cosas que el producto hoy no hace | Media |

**Lo que hay que decir con todas las letras:** el ahorro de costo es el argumento **más débil** acá, porque no hay gasto actual que reducir. El argumento fuerte es que **desbloquea dos módulos que el PRD deja sin motor** (DP-001, DP-002) y **habilita dos comportamientos nuevos** (DP-004, DP-007).

---

## 5. Features propuestas

Ordenadas por impacto × facilidad. Las cuatro primeras habilitan algo nuevo; las dos últimas mejoran algo previsto.

---

### **JV-1 · Clasificador del catálogo de tendencias** — S/M

Etiquetar cada item de la librería de trending en la ingesta: nicho, formato, estilo de hook, aptitud para remix y seguridad de marca.

- **Problema / para quién.** El PRD marca `F-041` como gap abierto y como riesgo legal/operativo. Sin taxonomía, ni Inspiration ni Blitz funcionan: el filtro por nicho y el "contenido de tu nicho" dependen de esto. Afecta a **todos** los usuarios, todo el tiempo.
- **Estado que recibe.** JSON: `{caption, hashtags[], ocrText, transcript?, platform, metrics{views,likes}, durationSec, isSlideshow}`. **Depende de OCR/ASR previo** (ya especificado en el PRD).
- **Preguntas** (una sola request, en paralelo):
  - `niche` → **Choice** sobre la taxonomía cerrada ya observada en Fastlane: `B2C App`, `B2B App`, `Productivity`, `Relationships`, `Personal Brand`, `Course/Digital Product`, `E-Commerce`, `Self Improvement`, `Travel`, `Study`, `none`.
  - `format` → **Choice**: `slideshow`, `wall-of-text`, `green-screen`, `talking-head`, `demo`, `other`.
  - `hookStyle` → **Choice**: `curiosity_gap`, `pov`, `listicle`, `confession`, `hot_take`, `tutorial`, `none`.
  - `remixable` → **Noul**: ¿se puede recrear el formato con otra marca sin depender de la persona o el producto original?
  - `brandSafe` → **Noul**: ¿libre de política, tragedia, contenido sexual, claims médicos o financieros?
- **Uso de la probabilidad.** `niche` con confianza < 0,5 → `none` y el item queda fuera del filtro por nicho (no se descarta: sigue siendo elegible en búsquedas generales). `brandSafe < 0,8` → cuarentena, revisión humana. `remixable < 0,6` → visible en Inspiration pero **no** elegible para la cola automática de Blitz.
- **Qué hace el LLM.** Nada. Es 100 % clasificación.
- **Dependencias.** OCR (`INT-016`, ya en Fase 1 del PRD). ASR opcional (Fase 2).
- **Métrica.** Acierto contra 200 items etiquetados a mano; y tasa de cuarentena — si supera el 5 %, los criterios están mal escritos.

---

### **JV-2 · Motor de scoring de leads de Reddit** — M

Puntuar cada post detectado en los subreddits configurados y priorizar a cuáles responder.

- **Problema / para quién.** `FR-140` especifica `Most Engaged Leads`, `Top Scored Leads` y `Why this lead?` pero **no define cómo se puntúa**. Sin motor, el módulo no existe. Es además el punto 12 y 14 del hilo de Twitter, aplicados literalmente.
- **Estado.** `{post{title, body, subreddit, author, postedAt, score, numComments}, brand{coreIdentity, productOffering, targetAudience}}`.
- **Preguntas** (una request):
  - `hasProblem` → **Noul**: ¿describe un problema que este producto resuelve?
  - `buyingSignal` → **Score** de 4 niveles: `solo comenta` / `frustrado con su solución actual` / `evaluando alternativas` / `pide recomendación explícita`.
  - `fitToAudience` → **Score** de 3: `fuera del público` / `adyacente` / `exactamente el público`.
  - `replyWelcome` → **Noul**: ¿el subreddit y el post admiten una respuesta con mención de producto sin ser spam?
  - `alreadyAnswered` → **Noul**: ¿ya hay una respuesta que resuelve lo que pide?
- **Composición.** Los pesos viven **en código**, no en el modelo (patrón *composite scoring*). `leadScore = 0.35·buyingSignal + 0.30·fitToAudience + 0.20·hasProblem + 0.15·replyWelcome`, con `alreadyAnswered > 0.7` como veto duro. Cambiar un peso **no** requiere reinferir nada — es el punto entero del patrón.
- **Umbrales.** `> 0.75` → `Top Scored Leads`. `0.4–0.75` → lista general. `< 0.4` → no se muestra. Los cinco scores crudos se persisten: si mañana cambia la política, se recalcula sin volver a llamar al modelo.
- **Qué hace el LLM.** `Why this lead?` y el borrador de respuesta (`Generate AI reply`) siguen siendo LLM. Jev decide *cuáles* merecen ese gasto — que es donde está el ahorro real.
- **Dependencias.** OAuth de Reddit (`INT-005`).
- **Métrica.** De los leads del top decil, ¿en cuántos el usuario efectivamente responde? Comparar contra orden cronológico.

---

### **JV-3 · Pre-flight de publicación** — M

Antes de programar, detectar lo que la plataforma va a rechazar, ajustar o penalizar.

- **Problema / para quién.** Hoy el usuario se entera **después**. El PRD documenta `instagram_repeated_mention`, `captionAdjustmentReason`, límites por plataforma y el carril lento de TikTok — todos post-mortem. Es la feature de mayor impacto percibido de la lista, porque convierte un fallo silencioso en un aviso accionable.
- **Estado.** `{caption, description?, platform, contentType, hasAiContent, disclosesPartnership, accountType}`.
- **Preguntas:**
  - `repeatedMention` → **Noul**: ¿repite la misma mención o handle de forma que Instagram suele recortar?
  - `policyRisk` → **Choice**: `none`, `medical_claim`, `financial_claim`, `undisclosed_promotion`, `restricted_topic`.
  - `needsAiLabel` → **Noul**: ¿parece contenido generado por IA que requiere etiqueta según la política vigente?
  - `hookQuality` → **Score** de 4 niveles sobre los primeros 2 segundos de copy.
- **Umbrales.** `policyRisk ≠ none` con confianza > 0,7 → bloquea con explicación y sugiere editar. 0,4–0,7 → advierte pero deja publicar. `hookQuality` bajo → sugerencia blanda, **nunca** bloqueo.
- **Qué hace el LLM.** Si el usuario acepta arreglar, el LLM reescribe. Jev detecta; el LLM corrige.
- **Riesgo propio.** Falsos positivos que bloqueen publicaciones legítimas. Por eso sólo `policyRisk` bloquea, y con umbral alto.
- **Métrica.** Caída en posts con `errorCode` de plataforma y en `captionAdjustmentReason`.

---

### **JV-4 · Verificador de campos de marca** — M

Comprobar que cada campo del `CompanyProfile` está realmente respaldado por el extracto del que se dedujo, y de ahí sacar `fieldMeta.confidence`.

- **Problema / para quién.** El PRD (`AI-016`, `DATA-004`) **exige** confianza por campo y una regla dura: *"nunca inventar"*. Pero no dice cómo se calcula esa confianza. Sin un mecanismo real, `high/medium/low` sería decorativo — y eso rompe la promesa central del onboarding social.
- **Estado.** `{fieldName, derivedValue, sourceExcerpt, sourceType}`.
- **Preguntas:**
  - `supported` → **Noul**: ¿el extracto respalda esta afirmación, sin necesidad de suponer nada que no esté ahí?
  - `specificity` → **Score** de 3: `genérico` / `parcialmente específico` / `específico de este negocio`.
- **Mapeo a la UI.** `supported > 0.85` y `specificity ≥ 2` → `high`. `supported > 0.6` → `medium`. Resto → `low`, y el campo entra en el bloque `Worth a quick check` que el PRD ya especifica, o dispara la pregunta de cierre de huecos.
- **Qué hace el LLM.** El LLM **deriva** el campo; Jev **verifica** que esté respaldado. Es el patrón *citation check*, con cookbook oficial.
- **Por qué importa más de lo que parece.** Es lo que hace que la regla "nunca inventar" sea verificable en vez de una aspiración.
- **Métrica.** Sobre 50 perfiles etiquetados a mano: ¿coincide el `low` de Jev con los campos que un humano marcaría como flojos?

---

### **JV-5 · Clasificador de tono de respuesta → ban meter** — S

Etiquetar cada respuesta enviada a Reddit como aporte de valor, mención sutil o promoción directa.

- **Problema / para quién.** El PRD define el medidor de riesgo con ratios explícitos (60-70 % valor / 20-30 % sutil / 10-20 % directo) pero no dice quién asigna la etiqueta.
- **Estado.** `{replyText, threadContext, brandName}`.
- **Pregunta.** `promoLevel` → **Choice**: `value_add`, `subtle_mention`, `direct_promo`.
- **La división de trabajo es el punto.** Jev etiqueta **una** respuesta. **El ratio y el nivel del medidor los calcula código**, porque Jev está documentado como poco fiable contando. Es el ejemplo más limpio de la frontera correcta.
- **Esfuerzo.** El más bajo de la lista: una pregunta, un enum de tres valores.
- **Métrica.** Acuerdo con etiquetado humano sobre 100 respuestas.

---

### **JV-6 · Rerank marca ↔ tendencia (y ↔ creador)** — M/L

Ordenar los candidatos de la librería por encaje real con la marca, en vez de filtrar por nicho.

- **Problema / para quién.** Blitz elige qué remixar con pesos y filtros. Un rerank semántico mejora directamente lo que el usuario ve en la primera tarjeta — que es el momento donde se gana o se pierde al usuario. **El mismo mecanismo aplica a elegir personaje AI UGC o video UGC humano** de las librerías de 1.000+ y 2.000+, que hoy el PRD resuelve con `genderFilter` y sets, o sea casi al azar.
- **Diseño.** Shortlist por código (nicho + recencia + engagement, ~30 candidatos) → un juicio por par marca-candidato → ordenar. El cookbook oficial reporta 1.200 pares por $0,0645, así que el costo no es el problema.
- **Pregunta.** `fits` → **Noul**: ¿el formato y el ángulo de este contenido funcionarían para esta marca sin forzar la relación?
- **Dependencias.** **Requiere JV-1** (sin taxonomía no hay shortlist).
- **Métrica.** Tasa de aceptación en Blitz (swipe derecha) contra el método actual de pesos. Es medible con A/B limpio.

---

## 6. Dónde NO usarlo

| Área | Por qué |
|---|---|
| **Generación de copy, hooks, ángulos, `Improve`/`Regenerate`, `Why this content`** | Jev no genera texto y está documentado que rinde mal si se lo fuerza. |
| **Mezcla de contenido y pesos de Blitz** | Muestreo determinístico que el usuario controla con sliders. Cambiarlo por un modelo destruye la propiedad que lo hace útil: que es exacto y auditable. |
| **Cualquier cosa con fechas u horas** — lead times, ventanas de publicación, techo de 30 días, `resetAt` | Debilidad documentada: *"trata las fechas como texto, no como cantidades ordenadas"*. |
| **Cualquier cosa que cuente** — ratios del ban meter, cuotas, `content saves`, límites de caracteres | Debilidad documentada: *"no cuenta de forma fiable"*, y el error crece con el tamaño de la entrada. |
| **Detección de plataforma desde una URL** | Una regex. Añadir un modelo acá es peor en todo. |
| **Validación de esquemas, límites de caracteres, unicidad** | Código. |
| **Razonamiento multi-paso** (p. ej. decidir una estrategia de campaña completa) | Documentado: la precisión cae con múltiples saltos de inferencia. |
| **Espacios de salida abiertos** | Choice tope 255 opciones; Score 2–10 niveles. Si no se puede enumerar, no es para Jev. |
| **Guardrail de prompt injection como única capa** | Ver §7. **Jev es vulnerable a injection por diseño.** |

---

## 7. Riesgos y mitigaciones

| # | Riesgo | Severidad | Mitigación concreta |
|---|---|---|---|
| **R1** | **Proveedor de ~3 semanas de vida.** `jev-1.13.0` y ya existe una guía de migración a v1: la API ya tuvo cambios de ruptura. | **Alta** | **Puerto `Judgment` desde el día 1.** Interfaz propia (`choice / score / noul` → resultado + probabilidad), con dos adaptadores: Jev y LLM-con-salida-estructurada. Nunca importar el SDK fuera del adaptador. El costo de hacerlo ahora, sin código, es ~0. |
| **R2** | **Latencia sin documentar.** El "70–500 ms" no existe en los docs. | Alta si se usa en rutas síncronas | **No poner Jev en ninguna ruta síncrona hasta medirlo.** JV-1, JV-2, JV-6 son batch/background y no lo necesitan. JV-3 sí (bloquea al usuario) → medir antes, y timeout con fallback a "no bloquear". |
| **R3** | **Sin benchmarks independientes.** Todo lo que hay son números del fabricante y un cookbook propio. | Media | El experimento de §8 **es** la mitigación. No adoptar nada sin medirlo en datos propios. |
| **R4** | **Vulnerable a prompt injection.** Documentado: *"no trata el estado como hostil por defecto"*. FastGram procesa bios y captions de terceros — exactamente el vector. | **Alta** | Sanitización determinística **antes** de Jev (stripping de imperativos, delimitadores, longitud máxima). Jev como *una* capa del guardrail, nunca la única ni la primera. Suite de regresión con bios adversariales — el PRD ya la exige en `FR-011`. |
| **R5** | **Degradación con estado grande e irrelevante.** Documentado. | Media | Filtrar el estado antes de enviarlo. No mandar el perfil de marca entero a una pregunta que sólo necesita dos campos. Medir la relación tamaño↔acierto. |
| **R6** | **Privacidad.** Se enviaría contenido de terceros (posts de Reddit, perfiles sociales ajenos) a un proveedor externo. | Media-alta | No entrenan con datos de usuario y ofrecen **zero data retention** para enterprise (`privacy@typesafe.ai`) — **negociarlo antes de producción, no después**. Nunca enviar tokens OAuth, PII de usuarios ni claves. Revisar el DPA junto con `OQ-16` del PRD, que ya cubre el tratamiento de datos de terceros. |
| **R7** | **Calidad en español y en el dominio.** Los docs no dicen nada sobre rendimiento multilingüe. El producto genera contenido en varios idiomas (`Multi-language content` en el plan Pro). | Media | Incluir contenido en español y portugués en el set de validación desde el primer experimento. Si el acierto cae, restringir Jev al inglés y usar LLM para el resto — la capa de abstracción lo permite sin tocar el resto. |
| **R8** | **Rate limits que "se ajustan dinámicamente"**, según sus propios docs. | Media | Colas con backoff y presupuesto por workspace. JV-1 es batch nocturno: si el límite baja, se estira, no se rompe. |
| **R9** | **Interpretación literal.** Responde lo que está escrito, no lo que se quiso decir. | Baja-media | Redactar `instructions` y `criteria` explícitos; `criteria` describiendo situaciones concretas, no adjetivos. Revisar los casos fallidos mirando el estado exacto enviado. |

---

## 8. Plan de validación

### Qué probar primero: **JV-1 (clasificador de catálogo)**

No porque sea el de mayor impacto —JV-2 y JV-3 lo son— sino porque **es el único que se puede validar sin que el producto exista**. Es offline, no necesita usuarios, no necesita frontend, no tiene restricción de latencia y el dataset se arma en un día.

### Experimento

| | |
|---|---|
| **Dataset** | 250 videos públicos en tendencia (TikTok + Reels), procesados a texto: caption, hashtags, OCR del overlay, métricas. **50 en español** para atacar R7. Etiquetado a mano: nicho, formato, remixable, brand-safe. ~1 día de trabajo. |
| **Baselines** | (a) reglas por keywords sobre hashtags — el piso realista; (b) un LLM con salida estructurada — el techo de calidad y el costo a batir. |
| **Variante Jev** | Las cinco preguntas de JV-1 en una sola request. |
| **Qué medir** | Acierto por dimensión vs. etiquetado humano · **calibración** (¿los items con confianza 0,9 aciertan ~90 % de las veces? diagrama de fiabilidad) · costo real por 1.000 items · latencia p50/p95 · **acierto en español vs. inglés** · sensibilidad al tamaño del estado (con y sin transcripción). |
| **Esfuerzo** | 2–3 días. |

### Criterios de decisión

**Seguir** si se cumplen las cuatro:
1. Acierto en `niche` y `format` **≥ el del LLM baseline − 5 pp**.
2. Costo **≤ 1/10** del LLM baseline, medido, no asumido.
3. **La calibración se sostiene** — sin esto, los umbrales de todas las features son humo, y es lo más importante de la lista.
4. La brecha español↔inglés **< 10 pp**.

**Parar** si: la calibración no se sostiene, o el acierto queda por debajo de las reglas por keywords, o la latencia p95 supera un segundo en batch.

### Qué hacer *hoy*, pase lo que pase con el experimento

Independientemente del resultado, y esto es lo único que recomiendo comprometer ahora:

1. **Añadir el puerto `Judgment` al PRD** como requisito de arquitectura, con su adaptador LLM como implementación por defecto. Cuesta un párrafo y elimina R1 casi entero.
2. **Marcar DP-001–DP-007 en el PRD** como puntos de decisión explícitos, con su enum de salida definido. Eso tiene valor **aunque Jev no se adopte nunca**: obliga a decidir la taxonomía antes de escribir el código, que es exactamente donde estos productos se rompen.
3. **No firmar nada.** No hay volumen que justifique un compromiso con un proveedor de tres semanas.

---

## 9. Sobre el hilo de Twitter

Cinco de los diez aplican, dos aplican dados vuelta, tres no. Y hay una advertencia que atraviesa la mitad de la lista.

| # | Idea | ¿Aplica a FastGram? |
|---|---|---|
| 11 | Ad creative scoring | **Parcial.** Aplica como pre-filtro de la cola de Blitz (JV-6). **Pero el hilo asume que se puntúan creatividades visuales, y Jev no ve imágenes.** Sólo funciona sobre la copy y el texto extraído. |
| 12 | Social post filtering | ✅ **Directo.** Es JV-2. |
| 13 | ICP detection | ⚠️ Débil. FastGram no tiene CRM ni prospección de cuentas. Lo más cercano es `fitToAudience` dentro de JV-2. |
| 14 | Buying signal detection | ✅ **Directo.** Es la pregunta `buyingSignal` de JV-2. |
| 15 | Comment prioritization | ⚠️ **Hoy no aplica, pero señala un hueco.** El producto publica y no gestiona los comentarios que llegan — salvo en Reddit. Sería una feature nueva, no una optimización. |
| 16 | Review analysis | ❌ No hay reviews en el producto. |
| 17 | Influencer matching | ✅ **Aplica, pero al revés.** No es matchear creadores externos: es **elegir qué personaje AI UGC (1.000+) o qué video UGC humano (2.000+) encaja con esta marca**, que hoy el PRD resuelve con `genderFilter` y sets — prácticamente al azar. Es JV-6 aplicado a otra librería, y probablemente el hallazgo más útil del hilo. |
| 18 | Sponsorship qualification | ❌ Fuera del producto. |
| 19 | UGC selection | ✅ **Igual que 17.** Con el mismo límite: sobre metadatos y texto, no sobre el video. |
| 20 | Product Hunt monitoring | ⚠️ Extensión natural del módulo de leads (otra fuente además de Reddit), no core. |

**La advertencia:** el hilo está escrito para un marketer que juzga *assets* —creatividades, videos, testimonios— y Jev es **text-only**. Todo lo visual necesita OCR/ASR/metadatos antes. Para FastGram eso es abordable porque ese pipeline ya está especificado (`INT-015`, `INT-016`), pero cambia el orden de la cola de trabajo: **primero el pipeline de extracción a texto, después Jev**. Sin eso, media lista no es implementable.

---

## Conclusión

Jev encaja genuinamente en **dos huecos que el PRD deja marcados** —la clasificación del catálogo de tendencias y el motor de scoring de leads— y habilita **dos comportamientos que el producto hoy no tiene**: avisar antes de publicar, y poder decir con honestidad qué campos del perfil de marca son dudosos.

Pero el argumento de costo, que es el que más se promociona, es el **más débil** en este caso: no hay gasto que reducir porque no hay código. Y el proveedor tiene tres semanas de vida, sin latencia publicada ni benchmarks independientes.

La decisión sensata no es "adoptar" ni "descartar": es **diseñar el puerto de abstracción ahora, que es gratis, correr el experimento de §8, que cuesta tres días, y decidir con datos propios cuando haya volumen real**.
