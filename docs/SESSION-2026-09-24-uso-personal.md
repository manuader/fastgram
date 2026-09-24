# Sesión 2026-09-24 — Uso personal: del plan a la app que se usa

El dueño pidió bajar a tierra "FastGram como piloto automático de redes para varias marcas, sin
límites, sólo para mí", actualizar el plan y seguir hasta tener features para probar. El plan
quedó en `PLAN-USO-PERSONAL.md`, las decisiones en PRD §2.7 (`D-06`…`D-17`) y la guía para el
dueño en `GUIA-DE-USO.md`. Acá va lo que costó tiempo y no se deduce del código.

## La investigación que cambió el plan

- **TikTok declara *not acceptable* "una herramienta para subir a las cuentas que vos manejás".**
  Sin auditoría todo sale privado, así que TikTok va por borrador (`IN_USER_INBOX`, D-10). El
  estado ya existía en el modelo.
- **Instagram y las fotos de TikTok traen la media por URL pública:** MinIO en localhost no
  sirve, de ahí el túnel. Y el túnel gratis no sirve para TikTok fotos (trampa 54).
- **Ningún scraper de Instagram o X anda bien sin login hoy.** El dueño rechazó usar una cuenta
  secundaria, así que queda anónimo, oficial (Business Discovery) o pegar a mano.
- **Higgsfield tiene API oficial, pero sin lipsync, personajes ni upscale.** Los Influencers
  no se planifican encima hasta que lo expongan.

## Cómo se trabajó

Cuatro tandas de 4 a 6 agentes con directorios disjuntos, un contrato fijado antes por el
coordinador cuando dos agentes lo compartían (marcas: `X-Fastgram-Workspace`) y migraciones
numeradas de antemano. Después de cada tanda: `pnpm verify`, `pnpm test:int` y **una pasada en
el navegador con la app real**. Cada pasada encontró algo que ningún test veía (ver la entrada
del HANDOFF §4 y las trampas 50–55). La proporción importa: ningún bug de esta lista era
detectable por los tests de la unidad que lo tenía.

## Decisiones del coordinador que el PRD no cubría

- **Perfil `partial` acepta en Blitz:** el refill ya generaba con ese perfil. Un deck lleno que
  no se puede aceptar es peor que un aviso "Worth a quick check".
- **Defaults del análisis web en `pnpm start`** (timeout 15 s, 3 MB, 5 redirects, 4 páginas,
  30 días de retención): límites de higiene para bajar una web, no cuotas. El worker sigue sin
  defaults propios.
- **Las marcas nacen en la zona horaria del navegador;** la de desarrollo, en la de la máquina.
- **El proceso de media pública reenvía sólo `GET /api/fastgram/oauth/<red>/callback`** a la web,
  en vez de abrir una segunda ruta del túnel hacia la app entera, que no tiene login.

## Lo que quedó sin verificar

- Toda la publicación, el OAuth, Higgsfield y fal contra las plataformas reales.
- `pnpm start --tunnel` completo, que sólo se probó por partes.
- Las fuentes del render en Linux (en curso con el agente de deploy).
- La calidad del copy y del análisis con un modelo mejor que el 7B local.
