# Paridad con Fastlane — estado al cierre del sprint 8

> 2026-09-24. Cierra `P5-PARITY-001`: las filas de PRD §23 recorridas contra el código, en modo
> personal (`D-06`…`D-17`). Cada fila queda **Anda**, **Adaptado** (cubierto de otra forma, con el
> porqué), **Fuera** (decisión escrita) o **Bloqueado** (depende de algo que no es código).
> Lo que "anda" y no corrió contra una plataforma real por falta de credenciales lo dice.

## Onboarding y marca

| Feature | Estado | Dónde / por qué |
|---|---|---|
| Signup, login, SSO, recuperación, borrar cuenta, invitaciones | Fuera | `D-06`: un usuario, sin auth. La rama `auth-y-suscripciones` queda |
| Análisis de web | Anda | Brand → Add source; sigue links de la bio (1 nivel, máx. 5) |
| Análisis de perfiles sociales | Adaptado | X (FxTwitter), YouTube (yt-dlp), LinkedIn (página pública) andan sin login; Instagram anónimo da 401 → pegar bio o **capturas con OCR**, o Business Discovery; TikTok con el contenedor de Evil0ctal |
| Fusión multi-fuente + trazabilidad por campo | Anda | `FieldProvenance`, confianza calibrada por JV-4 (verificado con qwen 7B: 7 campos) |
| Importar posts propios al Media Bank | Anda | Opt-in; IG y YouTube por cuenta conectada, perfil público de YouTube. TikTok y X no |
| Cuestionario de perfilado | Anda | Tarjeta en `/brand` |
| Guía de inicio | Adaptado | `docs/GUIA-DE-USO.md`; `/guide` oculto en modo personal |
| Perfil, edición por sección, revisión, re-análisis | Anda | Con guarda de revisión (409 si cambió en otra pestaña) y propuestas aceptables por campo |
| Sub-pasos del procesamiento | Anda | `analysis_phase` real (collecting → reading_links → synthesizing → verifying) |

## Home, Inspiration, Blitz

| Feature | Estado | Dónde / por qué |
|---|---|---|
| KPIs, tareas, historial | Adaptado | **Today** (publicado, programado, borradores de TikTok, aprobaciones, fallos) + Analytics |
| Feed de tendencias y catálogo de 25 000 videos | Fuera | `D-15`/`OQ-13`: derechos de catálogo. Lo reemplaza el tablero propio de Inspiration |
| Inspiration: búsqueda, filtro, Remix | Anda | Tablero propio con métricas públicas; Remix → Blitz |
| Blitz: cola, swipe, teclado, botones, Why, Remixed From, chips | Anda | `Remixed From` también para referencias elegidas por JV-6 en el refill |
| Editor inline (texto, fondo, video, **música**, meme) | Anda | La música llega al video (verificado: mezcla medida en el audio de la rev. 2) |
| Regenerate Text con prompt | Anda | Con el modelo `text` |
| Crear desde prompt, incluido **meme green-screen** | Anda | Elige el clip por tema (JV-6) y, si no hay, **lo busca en YouTube** y lo recorta. Verificado de punta a punta en ~20 s |
| Formatos IA desde el prompt | Anda | Con costo y confirmación; necesita modelo de video |
| Preferencias de Blitz | Anda | `/blitz/settings` |
| Tope diario de swipes | Fuera | `D-06`: se cuenta, no se limita |

## Content Studio, Influencers, AI Studio

| Feature | Estado | Dónde / por qué |
|---|---|---|
| 4 formatos base con Create New / Remix, preview, swap por slide, estilos | Anda | `/content/<formato>` |
| Custom upload | Anda | Normaliza y cierra `CREATED` |
| 17 formatos IA | Anda 15/17 | 7 de texto sobre clip generado + 8 con voz sobre fal (TTS + OmniHuman) + character swap (Wan Animate). `talking-objects` y `green-screen-mobile-app` fuera por decisión del dueño (sin modelo verificado). Sin probar contra fal real |
| Influencers: wizard, base propia o por texto, entrenamiento, galería, templates, configuración, regenerar | Adaptado | Higgsfield Soul ID en vez de LoRA propio; sin créditos (`D-06`) |
| Video del influencer | Adaptado | "Animate this image" (image-to-video). Sin probar contra Higgsfield real |
| Talking Head UGC | Anda | Con un modelo de la biblioteca y su voz (fal). Sin probar contra fal real |
| AI Studio con referencias y contador | Anda | Picker del Media Bank; necesita key de Higgsfield/fal o ComfyUI |
| Filtros de contenido | Anda | `nsfw_rejected` con mensaje propio |
| Librerías de personajes y UGC | Adaptado | **Biblioteca de modelos propia** (`/models`): varios modelos importados, compartidos entre marcas, con UGC y talking head. Sin catálogo de terceros (`OQ-13`) |

## Library, Calendar, Scheduling, Analytics

| Feature | Estado | Dónde / por qué |
|---|---|---|
| My Posts con métricas, Cancel/Reschedule/Retry, Refresh, selección masiva | Anda | |
| My Content con Schedule / Auto-slot / Edit | Anda | |
| Media Bank: categorías, búsqueda, tags, sets, deep-links, miniaturas | Anda | |
| Biblioteca de audio | Adaptado | Por marca (subir, importar por link, extraer de un video) en vez de una librería compartida |
| Calendario mes/semana, chips, drag & drop, todas las marcas | Anda | Abrir un post con teclado: `E` |
| Programar: redes, caption por red con Improve/Regenerate, fecha/hora, Post now, Reel/carrusel | Anda | Sin probar contra las redes (faltan credenciales) |
| Etiqueta IA / paid partnership | Adaptado | Sólo donde la API lo soporta (YouTube) |
| Máquina de estados del post, lane lento de TikTok 72 h, reconexión | Anda | |
| Analytics por red y por formato, auto-tune del mix | Anda | Necesita cuentas conectadas; TikTok borrador no da métricas |
| Website analytics, atribución de ads/ventas | Fuera | `D-15` |

## Automatización, Engagement, Settings

| Feature | Estado | Dónde / por qué |
|---|---|---|
| Automations (campañas) | Anda | |
| Piloto automático por marca | Anda | Pre-chequeo JV-3 con modelo propio (`judgment.autopilot`) |
| Engagement Reddit | Adaptado | La API de Reddit exige aprobación: flujo manual con "Copy & open thread" |
| Notificaciones | Anda | Campana + ntfy/Telegram (en vez de email) |
| Settings (hub, marcas, estrategia, modelos, integraciones, conexiones, notificaciones) | Anda | |
| Warmed Accounts | Fuera | `D-15` |
| Billing, planes, créditos, API pública, MCP, partners, referidos, roadmap, changelog | Fuera | `D-06`/`D-15` |
| Multi-idioma | Anda | El copy sale en el idioma de la estrategia de la marca |

## Lo que queda abierto de verdad

1. **Credenciales del dueño** para la primera publicación real (ver `GUIA-DE-USO.md` §4).
2. Keys de Higgsfield y fal para probar modelos, voz y formatos IA contra el servicio real.
3. `P2-JV-002/003`: dataset etiquetado a mano (sólo si la app se abre a terceros).
