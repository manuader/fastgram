# Guía de uso — FastGram en tu Mac

> Para el dueño, 2026-09-24. Qué podés usar hoy, cómo, y qué necesita algo de tu lado.
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
| **Settings → Brands** | Una marca por cliente, influencer o idea. Crear, renombrar, borrar | **New brand** → nombre → **Switch and analyse** |
| **Brand** | Pegás la web de la marca y la IA arma el perfil: identidad, oferta, tono y audiencia, con el origen y la confianza de cada campo | **+ Add source** → la web → **Analyse**. En 1–2 min aparece el perfil. Revisá lo marcado "Worth a quick check" |
| **Library → Media Bank** | Tus imágenes y videos para el contenido | **Upload** (varios a la vez), **Generate brand backgrounds** (fondos con la paleta de la marca, gratis y locales) o **Import from link** (un clip de TikTok, YouTube o X; si es de pantalla verde, se recorta solo) |
| **Blitz** | La IA propone piezas y vos decidís | → o arrastrar a la derecha: aceptar. ← o a la izquierda: descartar. **Edit**: abre el editor. **Schedule Post**: agenda en el próximo horario libre. Arriba, **Create from prompt**: "un meme sobre los lunes para mi cafetería" |
| **Editor** | Texto, fuente, color, contorno, posición (arrastrando), fondo, video y audio. Lo que ves es lo que sale | Cambiá el texto → **Save changes** → en ~20 s el video nuevo. **Regenerate Text** con un prompt opcional reescribe el copy con la IA |
| **Settings → Strategy** | Por marca: redes, piezas por día, horarios, zona horaria, idioma y **autonomía** (manual o piloto) | Ajustá los horarios: el auto-agendado los usa |
| **Calendar** | Semana y mes, arrastrar para mover, una marca o todas | Después de un **Schedule Post** aparece acá |
| **Today** | Lo de hoy en todas las marcas: publicado, programado, borradores de TikTok para terminar en el celular, lo que espera aprobación y lo que falló | Es la pantalla de inicio |
| **AI Studio** | Generar imágenes y videos con Higgsfield o fal, con costo estimado y tope mensual | Necesita una key (ver §4) |
| **⌘K** | Ir a cualquier lado, cambiar de marca, "Create from prompt…" | ⌘K desde cualquier pantalla |

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

## 6. Lo que todavía no está

Los avances en curso están en `tasks.md` §PU:

- Piloto automático, métricas y ajuste automático del mix.
- Leer perfiles de Instagram, TikTok y X para el análisis de marca. Hoy sólo la web. Instagram y X
  sin login funcionan mal: la alternativa es pegar la bio a mano.
- Deploy a un VPS para publicar con la Mac apagada.

Más adelante: YouTube, LinkedIn, modelos locales de imagen (ComfyUI), influencers IA, Reddit e
Inspiration.
