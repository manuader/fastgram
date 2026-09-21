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
