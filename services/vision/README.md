# services/vision

OCR (Fase 1) y ASR (Fase 2). HTTP, sin estado, escala aparte.

## Por qué existe como servicio separado

Su perfil de recursos no se parece al de la API: ráfagas de CPU y memoria al
cargar el modelo, nada de IO de base. Meterlo en el mismo proceso obligaría a
dimensionar la API por el pico del OCR.

## Correr en local

```
uv venv --python 3.12 .venv
uv pip install -e ".[dev]"        # sin motor de OCR
uv pip install -e ".[dev,ocr]"    # con PaddleOCR (pesado)
.venv/bin/python -m pytest -q
.venv/bin/uvicorn app.main:app --reload --port 8000
```

**Arranca sin PaddleOCR a propósito.** `GET /health` publica `ocr_available`.
Si es `false`, todo análisis devuelve `partial`: eso es lo que manda `AI-016`,
y es preferible a que el stack entero no levante en la máquina de desarrollo.
Lo que NO se puede permitir es que un deploy sin motor parezca sano — por eso
`ocr_available` está en el health y hay un warning al arrancar.

## La regla que no se puede romper

> `AI-016`: un fallo de OCR degrada a `partial`, **no** aborta.

Un alta que se cae entera porque una miniatura no se pudo leer es peor producto
que un perfil con un campo menos. `tests/test_degradacion.py` es la red de esa
regla: si alguien deja que una excepción del motor suba, ahí se rompe.

## Trampa de ffmpeg

Muchos builds vienen sin el filtro `drawtext` (necesita libfreetype). Cuando
falta, ffmpeg escribe "Filter not found", produce **cero frames** y sale con
código 0. Un pipeline que no cuente los archivos de salida lo lee como "el
video no tenía texto". Por eso `frames.py` no usa `drawtext` y cuenta lo que
salió. Ver `docs/HANDOFF.md` §7.

## Instagram sin login — `POST /social/instagram/profile` (`PU-SCRAPE-001`)

Perfil público + últimos N posts con **instaloader anónimo** (`D-13`: ninguna
cuenta logueada). Extra opcional, versión fija (la auditada, ver
`docs/AUDITORIA-SCRAPERS.md`):

```
uv pip install -e ".[dev,social]"     # instaloader==4.15.3
```

Sin el extra, la ruta contesta `503 extractor_unavailable` y `GET /health`
publica `instagram_available: false`: la fuente de Instagram degrada a D y la
UI ofrece pegar la bio.

Cuerpo: `{"username": "mimarca", "limit": 12}` (`limit` 0–24; con ≤ 12 alcanza
una sola llamada a Instagram). Errores con código estable en
`{"error": {"code", "message", "reason"?, "retry_after"?}}`:
`platform_rate_limited` (429 + `Retry-After`), `profile_unavailable` (404
`not_found` / 403 `private`), `platform_unavailable` (502), `invalid_username`
(400), `extractor_unavailable` (503).

El anónimo **tira 429 seguido** (issue #2726). Por eso: cache en memoria
(`SOCIAL_IG_CACHE_TTL_SECONDS`, 6 h), ni un reintento adentro, y enfriamiento
después de un 429 (`SOCIAL_IG_COOLDOWN_BASE_SECONDS` 300 s, duplicándose hasta
`SOCIAL_IG_COOLDOWN_MAX_SECONDS` 3600 s) durante el cual se contesta 429 sin
tocar Instagram. Los defaults son decisiones de este servicio, no números de
Instagram. El detalle está en `app/social/instagram.py`.
