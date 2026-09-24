# Guía de uso — FastGram en tu Mac

> Para el dueño, 2026-09-24 (actualizada con el sprint 7). Qué podés usar hoy, cómo, y qué necesita algo de tu lado.
> El detalle técnico está en [`PLAN-USO-PERSONAL.md`](PLAN-USO-PERSONAL.md) y en `tasks.md` §PU.

## 1. Arrancar

```bash
pnpm start
```

Levanta todo en orden (Postgres, MinIO, render con fuentes, API, worker, web) y lo baja con
**Ctrl+C**. Cuando dice `FastGram listo → http://localhost:3000`, abrí esa URL.

- Tus keys y ajustes van en `.env.local` en la raíz del repo, que está ignorado por git. También
  se cargan desde la app: **Settings → Models** e **Integrations** los guardan en `~/.fastgram/`,
  fuera del repo.
- `pnpm start --tunnel` además abre un túnel de Cloudflare. Hace falta para **publicar en
  Instagram**, porque Instagram baja la media de una URL pública (ver §4).
- Si corrés los tests (`pnpm test:int`) con la app levantada, **no pasa nada**: usan sus propias
  bases (`fastgram_api`, `fastgram_worker`). Hasta el 2026-09-24 no era así y te borraban los
  datos.

## 2. Lo primero: un modelo de texto

Sin modelo, Blitz no genera nada.

**Settings → Models → Text**

- **Gratis y local** (ya instalado): proveedor `Ollama · local` → **Load models** → elegí
  `qwen2.5:7b-instruct` → Context window `32768` → **Test connection** → **Save**. Anda sin
  internet, pero es un modelo chico: el copy sale correcto, no brillante, y el análisis de marca
  marca varios campos como dudosos.
- **Mejor calidad** (US$ unos pocos por mes): `OpenRouter`, `DeepSeek` o `Groq` con tu API key.
  Se cambia en caliente: el worker lo toma en el próximo job, sin reiniciar.

## 3. Qué podés hacer hoy

| Pantalla | Qué hace | Cómo probarlo |
|---|---|---|
| **Settings → Brands** | Una marca por cliente, influencer o idea. Crear, renombrar, borrar (borrar cancela sus posts, su piloto y sus campañas) | **New brand** → nombre → **Switch and analyse** |
| **Brand** | Pegás la web (o un perfil de X, YouTube o LinkedIn) y la IA arma el perfil, sigue los links de la bio y verifica cada campo contra su fuente (confianza real). Además: 6 preguntas de perfilado, **logo**, **ángulos de contenido** ("Suggest an angle"), y las propuestas de un re-análisis para aceptar o descartar | **+ Add source** → **Analyse**. Para Instagram sin login: "Paste your bio" o **subir capturas** (se leen con OCR) |
| **Library → Media Bank** | Tus imágenes y videos para el contenido, con **búsqueda, filtros por categoría y etiquetas** (los clips importados se etiquetan solos si hay modelo de visión) y **sets** | **Upload**, **Generate brand backgrounds**, **Import from link** o **Import my posts** (tus posts de una cuenta conectada o de un perfil público de YouTube) |
| **Blitz** | La IA propone piezas y vos decidís | → o arrastrar a la derecha: aceptar. ← o a la izquierda: descartar. **Edit**: abre el editor. **Schedule Post**: agenda en el próximo horario libre. Arriba, **Create from prompt**: "un meme sobre los lunes para mi cafetería" |
| **Editor** | Texto, fuente, color, contorno, posición (arrastrando), fondo, video y audio. Lo que ves es lo que sale | Cambiá el texto → **Save changes** → en ~20 s el video nuevo. **Regenerate Text** con un prompt opcional reescribe el copy con la IA |
| **Settings → Strategy** | Por marca: redes, piezas por día, horarios, zona horaria, idioma y **autonomía** (manual o piloto) | Ajustá los horarios: el auto-agendado los usa |
| **Calendar** | Semana y mes, arrastrar para mover, una marca o todas | Después de un **Schedule Post** aparece acá |
| **Today** | Lo de hoy en todas las marcas: publicado, programado, borradores de TikTok para terminar en el celular, lo que espera aprobación y lo que falló | Es la pantalla de inicio |
| **AI Studio** | Generar imágenes y videos con Higgsfield o fal, con costo estimado y tope mensual | Necesita una key (ver §4) |
| **⌘K** | Ir a cualquier lado, cambiar de marca, "Create from prompt…" | ⌘K desde cualquier pantalla |
| **Blitz → Create from prompt → Green Screen** | Escribís el tema ("cuando el cliente pide una revisión más") y arma un meme: elige el clip de tu Media Bank que mejor encaja con el tema y, **si no tenés ninguno, lo busca solo en YouTube**, lo baja y le recorta el verde. La tarjeta ya muestra el meme recortado sobre el fondo de la marca | El meme sale entero en la mitad de abajo, con el caption arriba. Un clip de menos de 5 s se repite (Instagram no acepta Reels de menos de 3 s) |
| **Studio** (`/content`) | Armar una pieza a mano, paso a paso: elegís fondo, meme, imágenes o demo del Media Bank, escribís el texto o lo genera la IA, elegís estilo → Save abre el editor. También **Remix** desde Inspiration y **Custom** (tu propio video) | Los 17 "AI formats" necesitan un modelo de video (ver §4); hoy andan 7 |
| **Library → Audio** | La música de la marca: subir MP3/M4A/WAV, importar por link (Import from link → Audio) y elegir cuáles usa Blitz solo. En el editor, **Swap** en Audio | En un meme, el sonido del clip queda al 100 % y la música debajo al 30 % |
| **Programar a mano** | Desde Blitz ("Schedule…"), el detalle de una pieza, el editor o el calendario: redes, **caption por red** (con Improve/Regenerate por IA y contador), fecha y hora de la marca, **Post now**, Reel o carrusel en Instagram | Un post fallido se reintenta o reprograma desde Today o Library → My Posts (también selección masiva) |
| **Campana 🔔** | Lo que pasó: publicado, fallido, borrador de TikTok listo, conexión vencida o por vencer, rechazos del piloto, campañas, resumen diario, cola trabada | **Settings → Notifications**: avisos al celular por **ntfy** (sin cuenta) o **Telegram** (tu bot) |

## 4. Lo que necesita algo de tu lado

**Todo el código de publicación está hecho y testeado, pero nunca corrió contra las redes reales:
faltan tus credenciales.** Lo primero que publiques va a ser la prueba de verdad. Probá con una
cuenta que no te importe.

| Para | Qué hacer | Dónde se carga |
|---|---|---|
| **Instagram** | 1) Pasar la cuenta a **Business o Creator**. 2) En developers.facebook.com, crear una app y agregar **Instagram API with Instagram Login**, con tu cuenta como tester. 3) Copiar el **Instagram app ID y secret** (no el de Facebook). 4) Arrancar con `pnpm start --tunnel` y cargar la redirect URI https que muestra la pantalla | Settings → **Integrations**, después Settings → **Connections** → Connect Instagram |
| **Threads / Facebook Page** | La misma app de Meta: agregar el caso de uso Threads y el de Páginas. Cada uno tiene su propio ID y secret | Igual |
| **TikTok** | App en developers.tiktok.com con **Content Posting API** (Upload). Los posts llegan como **borrador**: lo terminás en la app de TikTok (Today te los lista). La redirect URI **tiene que ser https**: `--tunnel`. **Las fotos** (carruseles) además exigen un dominio verificado por DNS, y el túnel gratis no sirve: hace falta un túnel con nombre y dominio propio | Igual |
| **X** | Cuenta de desarrollador con crédito. Cobra por post: US$0,015, o US$0,20 si lleva link, así que por defecto los links se sacan | Igual |
| **Imagen y video con IA** | Key de **Higgsfield** (console.higgsfield.ai, formato `KEY_ID:KEY_SECRET`) o de **fal** | Settings → Models → Image / Video, más el tope mensual |
| **Recortar memes que no son verdes** | Key de fal en Settings → Models → Background removal | Idem |
| **Etiquetado automático de clips** | Un modelo con visión en Settings → Models → Vision | Idem |

**Ojo con el túnel gratis:** su URL cambia cada vez que arrancás, y las redirect URIs de las apps
de desarrollador hay que actualizarlas en cada consola. Para no hacerlo cada vez, conviene un
**túnel con nombre** (`TUNNEL_TOKEN` + `FASTGRAM_PUBLIC_URL` en `.env.local`).

## 5. Cómo se protege a las cuentas

- Sólo se publica por las **APIs oficiales**. Nunca se automatiza el navegador.
- Por defecto, **3 posts por red y por día**, con ±7 min de variación en la hora y 10 min de
  separación entre marcas. Todo se cambia en Strategy.
- **Nunca la misma pieza en dos marcas.**
- Los valores por defecto son una elección nuestra, no un dato: ninguna red publica una
  "frecuencia segura".

## 6. Piloto automático, métricas y perfiles sociales

- **Piloto** (Settings → Strategy → Autonomy → Autopilot): la marca genera sola, cada pieza pasa un
  pre-chequeo (en tema, sin afirmaciones riesgosas, sin otras marcas, coherente, en el idioma) y
  lo que pasa se aprueba y se agenda. Lo que no pasa queda rechazado con el motivo en **Today**.
  Si el modelo no responde, la pieza espera tu revisión: **nunca se aprueba algo que no se juzgó**.
  **Ojo:** con el modelo local de 7B el chequeo de "otras marcas" es flojo. Antes de dejar una marca
  en piloto, poné un modelo mejor en Settings → Models → **Judgment**.
- **Analytics**: aparece cuando haya posts publicados y cuentas conectadas. X está apagado por
  defecto porque leer métricas cuesta US$0,005 por post (`METRICS_X_ENABLED=true` para prenderlo).
  TikTok no da métricas con el modo borrador. Con **Auto-tune content mix**, el mix de formatos se
  ajusta una vez por semana hacia lo que mejor rinde.
- **Perfiles sociales** en Brand → Add source:
  - **X**: funciona sin login (FxTwitter).
  - **Instagram sin login: hoy no funciona** (Instagram responde "login required"). Queda el panel
    **"Paste your bio and a few recent captions"**, o Business Discovery si conectás una cuenta con
    Facebook Login.
  - **TikTok**: hace falta levantar el contenedor de Evil0ctal (ver
    `docs/AUDITORIA-SCRAPERS.md` y el reporte en `tasks.md`); sin él, pegar la bio.

## 7. Publicar con la Mac apagada (VPS)

Todo está en [`deploy/README.md`](../deploy/README.md): Docker Compose, túnel con nombre, acceso
privado por SSH o Tailscale (la app no tiene login: **no la expongas a internet**), y backups con
restore probado. Antes de desplegar falta una decisión tuya: la licencia del build de FFmpeg
(`P0-REPO-004`).

## 8. Más herramientas

| Pantalla | Qué hace | Qué necesita |
|---|---|---|
| **Inspiration** | Tu tablero de referencias: pegás links de TikTok, Instagram, X o YouTube, se guardan con sus métricas públicas cuando el sitio las da, y **Remix this** genera piezas en Blitz inspiradas en esa referencia y adaptadas a la marca | Nada. YouTube trae vistas y likes sin login; Instagram sin login, poco o nada |
| **Influencers** | Personajes consistentes: subís 4–20 fotos, se crea el personaje (Higgsfield Soul ID) y después generás imágenes con él. Blitz lo usa según "influencer frequency" | Key de Higgsfield. Video con el personaje: todavía no (Higgsfield no lo documenta por API) |
| **Engagement** | Leads de Reddit: el puntaje se calcula en código, la IA arma la respuesta, **vos la mandás**, y un medidor de riesgo de ban frena si te pasás de promoción | La API de Reddit exige aprobación previa: sin ella, pegás el link del post y usás "Copy & open thread" |
| **Settings → Models → ComfyUI** | Imagen y video con modelos locales: pegás un workflow exportado en **formato API** | ComfyUI corriendo en tu Mac |
| **Automations** | Campañas de 1 a varias semanas: elegís marca, redes, frecuencia, mix y temas → se generan todas las piezas → las revisás (editar, captions por red, regenerar una) → **Launch** las agenda en el calendario | Un modelo de texto. Las redes sin conexión quedan reservadas y se publican cuando las conectes |
| **YouTube Shorts y LinkedIn** | Publicar como en las otras redes | Credenciales. **YouTube: pedí ya la auditoría del proyecto de Google**, sin ella los videos quedan privados |

### Modelos de juicio por decisión

**Settings → Models → Judgment by decision point**: podés usar un modelo más grande sólo para el
pre-chequeo del piloto (el de 7B deja pasar menciones a otras marcas), otro para verificar el perfil de
marca y otro para Engagement. Sin override, usan el de **Judgment**.

## 9. Lo que no está

- Métricas de TikTok (el modo borrador no las da) y de LinkedIn (permiso restringido).
- De los 17 formatos IA, los 9 con una persona que habla (talking head, news anchor…) y
  `character-swap`: ningún proveedor configurado ofrece voz/lip-sync o video-a-video por API.
- La fuente `snapchat` del editor: no hay una libre (TikTok Sans sí, desde el sprint 7).
- HDR → SDR en videos de iPhone: el ffmpeg de la Mac no lo trae; se conserva el original.
- Importar tus posts de TikTok (yt-dlp falla sin login) y de X (no soportado).
- Todo lo que depende de credenciales tuyas (§4) nunca corrió contra la plataforma real.
