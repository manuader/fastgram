"""Servicio de visión — HTTP, sin estado. P1-VISION-001.

Escala aparte del resto (IMPL §2.2) porque su perfil de recursos no se parece
al de la API: ráfagas de CPU y memoria al cargar el modelo, nada de IO de base.
"""

import logging
import os
import tempfile
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Annotated

import httpx
from fastapi import FastAPI, Header, HTTPException, Request

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


@app.post("/ocr/bytes", response_model=OcrResponse)
async def ocr_bytes(
    request: Request,
    content_type: Annotated[str | None, Header(alias="X-Media-Content-Type")] = None,
    sample_every_seconds: float = 2.0,
    max_frames: int = 12,
) -> OcrResponse:
    """Lee los bytes directamente del cuerpo, sin descargar nada.

    Es la forma correcta para este producto y no una comodidad. `DATA-032` y
    `FR-011` dicen que **los binarios de terceros no se persisten**: se
    procesan en memoria y se descartan. Si el servicio los descarga por URL,
    alguien tiene que haberlos guardado en algún lado primero — que es
    exactamente lo que la regla prohíbe.

    Existía ya un `POST /ocr` por URL y sigue existiendo para el Media Bank
    propio, donde el objeto sí vive en nuestro storage. Pero el adaptador
    `Ocr` pasa bytes, y para cubrir el hueco estaba levantando un servidor
    HTTP efímero en loopback y publicándose los bytes a sí mismo. Eso funciona
    en desarrollo y **deja de funcionar apenas los dos procesos vivan en
    contenedores distintos**, que es como van a correr.
    """
    engine = state.get("engine")
    if engine is None:
        raise HTTPException(status_code=503, detail="service not ready")

    body = await request.body()
    if len(body) == 0:
        raise HTTPException(status_code=400, detail="empty body")
    if len(body) > MAX_DOWNLOAD_BYTES:
        raise HTTPException(status_code=413, detail="payload too large")

    suffix = _suffix_for(content_type)
    fd, name = tempfile.mkstemp(suffix=suffix, prefix="vision-")
    path = Path(name)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(body)

        req = OcrRequest(
            url="inline://bytes",
            sample_every_seconds=sample_every_seconds,
            max_frames=max_frames,
        )
        if suffix in _VIDEO_SUFFIXES:
            if not ffmpeg_available():
                return OcrResponse(
                    status=OcrStatus.PARTIAL,
                    reason="ffmpeg no disponible: no se pudo leer el video",
                )
            return await analyse_video(engine, path, req)  # type: ignore[arg-type]
        return await analyse_image(engine, path, req)  # type: ignore[arg-type]
    finally:
        path.unlink(missing_ok=True)


def _suffix_for(content_type: str | None) -> str:
    """Extensión a partir del content type. ffmpeg y sharp la miran."""
    mapping = {
        "image/jpeg": ".jpg",
        "image/png": ".png",
        "image/webp": ".webp",
        "video/mp4": ".mp4",
        "video/quicktime": ".mov",
        "video/webm": ".webm",
    }
    return mapping.get((content_type or "").split(";")[0].strip().lower(), ".bin")


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
