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
from fastapi.responses import JSONResponse

from .frames import ffmpeg_available
from .models import HealthResponse, OcrRequest, OcrResponse, OcrStatus
from .ocr import build_engine
from .service import analyse_image, analyse_video
from .social.instagram import (
    InstagramError,
    InstagramProfileRequest,
    InstagramProfileResponse,
    InstagramReader,
    build_backend,
)

logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO").upper())
log = logging.getLogger("vision")

#: Tope de descarga. Un video de 500 MB no debería poder tumbar el servicio.
MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024

_VIDEO_SUFFIXES = {".mp4", ".mov", ".webm", ".m4v", ".avi"}

state: dict[str, object] = {}


def _env_float(name: str, default: float) -> float:
    raw = os.environ.get(name, "").strip()
    return float(raw) if raw else default


def build_instagram_reader() -> InstagramReader:
    """El lector de Instagram con la configuración del entorno.

    Los números por defecto son **decisiones de este servicio**, no del PRD ni
    de Instagram: 6 h de cache (una marca no cambia de bio cada hora y cada
    llamada ahorrada es un 429 menos), 5 min de enfriamiento después del
    primer 429 duplicándose hasta 1 h, 20 s de timeout por request.
    """
    return InstagramReader(
        build_backend(
            request_timeout=_env_float("SOCIAL_IG_REQUEST_TIMEOUT_SECONDS", 20.0),
        ),
        cache_ttl_seconds=_env_float("SOCIAL_IG_CACHE_TTL_SECONDS", 6 * 3600.0),
        cooldown_base_seconds=_env_float("SOCIAL_IG_COOLDOWN_BASE_SECONDS", 300.0),
        cooldown_max_seconds=_env_float("SOCIAL_IG_COOLDOWN_MAX_SECONDS", 3600.0),
    )


@asynccontextmanager
async def lifespan(_app: FastAPI):
    engine = build_engine()
    state["engine"] = engine
    instagram = build_instagram_reader()
    state["instagram"] = instagram
    if not instagram.available:
        log.warning(
            "instaloader no está instalado: POST /social/instagram/profile va a "
            "contestar 503 extractor_unavailable (instalá `instaloader==4.15.3`)."
        )
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
        instagram_available=bool(
            isinstance(state.get("instagram"), InstagramReader)
            and state["instagram"].available  # type: ignore[union-attr]
        ),
    )


@app.post(
    "/social/instagram/profile",
    response_model=InstagramProfileResponse,
    responses={
        400: {"description": "invalid_username"},
        403: {"description": "profile_unavailable (reason: private)"},
        404: {"description": "profile_unavailable (reason: not_found)"},
        429: {"description": "platform_rate_limited, con Retry-After"},
        502: {"description": "platform_unavailable"},
        503: {"description": "extractor_unavailable: instaloader no instalado"},
    },
)
async def instagram_profile(request: InstagramProfileRequest):
    """Perfil público + últimos N posts de Instagram, **sin login** (`D-13`).

    Ver `app/social/instagram.py` para el cache, el enfriamiento ante 429 y
    por qué no hay reintentos adentro. Los errores salen con un código estable
    en `{"error": {"code", "message", "reason"?, "retry_after"?}}`.
    """
    reader = state.get("instagram")
    if not isinstance(reader, InstagramReader):
        raise HTTPException(status_code=503, detail="service not ready")
    try:
        return await reader.read(request.username.lstrip("@"), request.limit)
    except InstagramError as err:
        headers = (
            {"Retry-After": str(err.retry_after)} if err.retry_after is not None else None
        )
        return JSONResponse(status_code=err.status, content=err.body(), headers=headers)


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
