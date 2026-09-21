"""Servicio de visión — HTTP, sin estado. P1-VISION-001.

Escala aparte del resto (IMPL §2.2) porque su perfil de recursos no se parece
al de la API: ráfagas de CPU y memoria al cargar el modelo, nada de IO de base.
"""

import logging
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path

import httpx
from fastapi import FastAPI, HTTPException

from .frames import ffmpeg_available
from .models import HealthResponse, OcrRequest, OcrResponse, OcrStatus
from .ocr import build_engine
from .service import analyse_image, analyse_video

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
log = logging.getLogger("vision")

#: Tope de descarga. Un video de 500 MB no debería poder tumbar el servicio.
MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024

_VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".m4v", ".avi"}

state: dict[str, object] = {}


@asynccontextmanager
async def lifespan(_app: FastAPI):
    engine = build_engine()
    state["engine"] = engine
    if not engine.available():
        # Arranca igual, pero que quede en el log del deploy. El estado sano
        # con motor ausente es la falla silenciosa que queremos evitar.
        log.warning(
            "el servicio arranca SIN motor de OCR: todo análisis va a degradar "
            "a `partial`. Instalá el extra `ocr` si no es lo que querés."
        )
    yield
    state.clear()


app = FastAPI(title="FastGram Vision", version="0.0.0", lifespan=lifespan)


@app.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    engine = state.get("engine")
    available = bool(engine and engine.available())  # type: ignore[union-attr]
    return HealthResponse(
        status="ok",
        service="vision",
        ocr_engine=getattr(engine, "name", "none"),
        ocr_available=available,
    )


@app.post("/ocr", response_model=OcrResponse)
async def ocr(request: OcrRequest) -> OcrResponse:
    engine = state.get("engine")
    if engine is None:
        raise HTTPException(status_code=503, detail="service not ready")

    try:
        path, suffix = await _download(request.url)
    except httpx.HTTPError as e:
        log.warning("no se pudo descargar %s: %s", request.url, e)
        # Degradar, no abortar: `AI-016`.
        return OcrResponse(
            status=OcrStatus.PARTIAL, reason="no se pudo descargar el objeto"
        )

    try:
        if suffix in _VIDEO_SUFFIXES:
            if not ffmpeg_available():
                return OcrResponse(
                    status=OcrStatus.PARTIAL,
                    reason="ffmpeg no disponible: no se pudo leer el video",
                )
            return await analyse_video(engine, path, request)  # type: ignore[arg-type]
        return await analyse_image(engine, path, request)  # type: ignore[arg-type]
    finally:
        path.unlink(missing_ok=True)


async def _download(url: str) -> tuple[Path, str]:
    suffix = Path(httpx.URL(url).path).suffix.lower()
    fd, name = tempfile.mkstemp(suffix=suffix or ".bin", prefix="vision-")
    path = Path(name)
    written = 0
    try:
        async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                with os.fdopen(fd, "wb") as f:
                    async for chunk in response.aiter_bytes(64 * 1024):
                        written += len(chunk)
                        if written > MAX_DOWNLOAD_BYTES:
                            raise httpx.HTTPError("el objeto excede el tope de descarga")
                        f.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return path, suffix
