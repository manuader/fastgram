# Sesión 2026-09-24 (3) — Sprint 7: cerrar los huecos contra Fastlane

## El pedido

"Continuá hasta que todas las features estén cubiertas, sin parar hasta terminar todos los tasks,
con el objetivo del plan de uso personal."

## Qué se hizo, en orden

1. **Auditoría antes de construir.** `tasks.md` tenía ~230 tareas `P1–P5` abiertas que nunca se
   reconciliaron con el backlog PU (la regla "se tachan las dos juntas" no se cumplió). Cuatro
   lecturas en paralelo (P1, P2, P3–P5 y la Parity Matrix de PRD §23, 96 filas) contra el código.
   Resultado: 75 hechas sin tachar, 56 fuera por `D-06/13/15/16`, 6 bloqueadas por personas y
   **69 huecos reales**.
2. **Primera tanda (7 agentes, A–G)**: publicación, audio, memes por tema, marca, avisos,
   Studio/Media Bank, formatos IA/influencers. Migraciones `0024–0030` **pre-reservadas** como
   `SELECT 1` con su entrada en el journal, para que nadie peleara el `_journal.json`.
3. **Integración + navegador**, donde aparecieron cuatro problemas que ningún test veía (abajo).
4. **Segunda tanda (3 agentes, H–J)**: sub-pasos del análisis, oferta post-análisis, Remixed From
   en el refill, extraer audio; guardas de URLs en `POST /content`, config del influencer en Blitz,
   formatos IA desde el prompt, miniaturas; a11y y estados de error.
5. Cierre: `tasks.md` sin tareas abiertas fuera de la plantilla de DoD, 11 `[!]` con motivo,
   `docs/PARIDAD-FASTLANE.md`.

## Lo que costó y no se deduce del código

- **Todo post que no salía de Automations se publicaba con caption vacío.** `bareTarget()` creaba
  posts con `caption: null` y el publisher mandaba `?? ""`. Lo encontró la auditoría de la Parity
  Matrix, no un test. Ahora el caption se deriva por red de la copy de la pieza en tres lugares
  (API, conversión de slots, y el publisher como red).
- **La música nunca llegaba al video**: el worker firmaba el grant con `sharedPrefixes: []` y el
  catálogo global no tenía seed. La biblioteca de audio es ahora por marca (`audio/{companyId}/`).
- **Buscar el meme con el tema literal no sirve.** "when the client asks for just one more
  revision green screen meme" devolvió 8 resultados de 65 s a 3 h y ninguno verde. YouTube indexa
  memes por **reacción** ("facepalm" → 8 clips verdes de 2–10 s). El modelo de texto traduce el tema
  a palabras de reacción y el tema literal queda como segunda búsqueda. Con qwen 7B la traducción
  fue "one more revision" (no una reacción) y aun así encontró un clip verde: Peter Griffin, 2,27 s.
- **`fill` a canvas completo con `cover` destruye un meme 16:9 en 9:16**: se ve ~30 % del ancho.
  El green-screen ahora va `contain` en el 65 % de abajo; el `fit` tuvo que viajar por cinco capas
  (contracts → core → ports → worker → wire). El editor decía `object-fit: fill` "porque el render
  estira", y era falso: el render hace `cover` por defecto.
- **Un meme de 2,27 s no es publicable en Instagram** (Reels ≥ 3 s). El render repite el clip con
  `-stream_loop` hasta ≥ 5 s. Verificado: 2,27 → 7,0 s, con la música mezclada.
- **qwen 7B escribe hashtags en chino en copy en inglés** (`#精益求情`). Guarda: con un idioma de
  alfabeto latino, otro alfabeto descarta la copy (`foreign_script`).
- **Los tests de API leían el `~/.fastgram` real del dueño y llamaban a su Ollama.** Los cuatro
  configs de vitest de api/worker ponen ahora un `FASTGRAM_HOME` temporal.
- **Suites de integración en paralelo se traban** en los `truncate` de una base compartida (visto
  por dos agentes). Un agente que corre `test:int` a la vez que otro usa `DATABASE_URL` propio.
- **`pnpm verify` con `next dev` corriendo** da errores de tipos en `.next/types`: verificar con la
  app bajada.
- TikTok Sans es OFL en Google Fonts desde 2025: 11 de las 12 familias ya bajan (37 `.ttf`).

## Verificado en la app real (Focus Creatives, Ollama qwen2.5 7B)

Settings hub; campana con un aviso real (campaña lista); Content Studio; **Blitz → prompt →
green screen → búsqueda automática → clip importado y recortado → tarjeta con el meme recortado**;
diálogo Schedule… (zona de la marca, próximo slot, Post now; redes deshabilitadas sin conexión);
render final 1080×1920 mirado frame por frame; importar audio por link; swap de audio en el editor
→ rebuild con música (medido en el audio); Media Bank con búsqueda, tags y sets; página de marca
con perfilado, ángulos (generado con el LLM real), logo, oferta post-análisis; re-análisis con
sub-pasos y **JV-4 verificando 7 campos** (low → medium/high).

## Sin verificar

Todo lo que necesita credenciales (publicar, Higgsfield, fal, formatos IA, video de influencer,
Telegram/ntfy reales, import de posts por cuenta conectada). La extracción de audio de punta a punta
(sólo el ffmpeg real en unit). La UI de la segunda tanda sólo en jsdom, salvo la página de marca.
Lector de pantalla real. HDR→SDR.

## Oráculo final

`pnpm verify` 18/18 · `pnpm test:int`: worker 373, api 738 (+11 skip), db 260, adapters 9.
