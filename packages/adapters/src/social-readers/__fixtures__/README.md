# Fixtures de los extractores sociales

Ninguno sale de una llamada real (regla del brief: nada de pedir a Instagram, TikTok
o X en los tests). Cada uno tiene **la forma** que documenta la herramienta en la
versión fijada; los valores son inventados, y las bios traen texto adversarial a
propósito (`P1-BRAND-019`).

| Archivo | Forma tomada de |
|---|---|
| `vision-instagram-profile.json` | `services/vision/app/social/instagram.py` (`InstagramProfileResponse`), el contrato de este repo |
| `dtk-tiktok-user.json` | Evil0ctal `v5.1.1` (`737bf3d`): sobre de `documents/en/11-api.md` + `Author` de `src/dtk/models/content.py` |
| `dtk-tiktok-user-posts.json` | ídem: sobre + `Page[Content]` de `src/dtk/models/content.py` |
| `fxtwitter-profile.json` | FxEmbed `c422d52`: `UserAPIResponse` / `APIUser` de `docs/specs/fxtwitter-openapi.json` |
| `fxtwitter-statuses.json` | ídem: `APISearchResults` / `APITwitterStatus` |
| `business-discovery.json` | ejemplo de respuesta de developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery, con los campos públicos de IG User e IG Media |
