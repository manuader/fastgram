"""Lógica del análisis, separada del transporte para poder testearla sin red.

La regla que gobierna este archivo es de `AI-016`:

    "Un fallo de OCR (o de ASR en Fase 2) degrada a `partial`, **no** aborta."

Es fácil de romper sin darse cuenta: basta con dejar que una excepción suba.
Por eso cada punto donde el motor puede fallar está capturado explícitamente y
convertido en un `OcrResponse` parcial con su razón.
"""

import logging
import tempfile
from pathlib import Path

from .frames import FrameExtractionError, extract_frames
from .language import detect_language
from .models import OcrRequest, OcrResponse, OcrStatus, TextBlock
from .ocr import OcrEngine

log = logging.getLogger("vision.service")

#: Debajo de esto el bloque es ruido: marcas de agua, handles diminutos,
#: artefactos de compresión leídos como letras. Entra al texto pero no se
#: cuenta para decidir el idioma.
MIN_USEFUL_CONFIDENCE = 0.5


async def analyse_image(
    engine: OcrEngine, image_path: Path, _request: OcrRequest
) -> OcrResponse:
    try:
        blocks = engine.read(image_path)
    except Exception as e:
        # A propósito: `Exception` y no una clase concreta. El motor es de
        # terceros y puede lanzar cualquier cosa; lo que NO puede hacer es
        # tumbar el análisis de marca entero.
        log.warning("OCR falló sobre %s: %s", image_path.name, e, exc_info=True)
        return OcrResponse(
            status=OcrStatus.PARTIAL,
            reason="el motor de OCR no pudo leer la imagen",
            frames_analysed=0,
        )

    return _build_response(blocks, frames=1, status=OcrStatus.OK)


async def analyse_video(
    engine: OcrEngine, video_path: Path, request: OcrRequest
) -> OcrResponse:
    with tempfile.TemporaryDirectory(prefix="vision-frames-") as tmp:
        try:
            frames = await extract_frames(
                video_path,
                Path(tmp),
                every_seconds=request.sample_every_seconds,
                max_frames=request.max_frames,
            )
        except FrameExtractionError as e:
            log.warning("no se pudieron extraer frames de %s: %s", video_path.name, e)
            return OcrResponse(
                status=OcrStatus.PARTIAL,
                reason="no se pudieron extraer frames del video",
                frames_analysed=0,
            )

        blocks: list[TextBlock] = []
        failed = 0
        for frame in frames:
            try:
                for b in engine.read(frame.path):
                    blocks.append(b.model_copy(update={"at_second": frame.at_second}))
            except Exception as e:
                # Un frame ilegible no invalida los otros once.
                failed += 1
                log.warning("OCR falló en el frame t=%s: %s", frame.at_second, e)

        if failed == len(frames):
            return OcrResponse(
                status=OcrStatus.PARTIAL,
                reason="el motor de OCR no pudo leer ningún frame",
                frames_analysed=len(frames),
            )

        status = OcrStatus.PARTIAL if failed else OcrStatus.OK
        reason = (
            f"{failed} de {len(frames)} frames no se pudieron leer" if failed else None
        )
        return _build_response(blocks, frames=len(frames), status=status, reason=reason)


def _build_response(
    blocks: list[TextBlock],
    *,
    frames: int,
    status: OcrStatus,
    reason: str | None = None,
) -> OcrResponse:
    deduped = _dedupe(blocks)
    # El idioma se decide sólo con los bloques confiables: una marca de agua
    # mal leída no debería decidir en qué idioma habla la marca.
    confident = " ".join(b.text for b in deduped if b.confidence >= MIN_USEFUL_CONFIDENCE)
    return OcrResponse(
        status=status,
        blocks=deduped,
        detected_language=detect_language(confident),
        reason=reason,
        frames_analysed=frames,
    )


def _dedupe(blocks: list[TextBlock]) -> list[TextBlock]:
    """Quita texto repetido entre frames consecutivos.

    Un overlay de TikTok dura varios segundos, así que el mismo texto aparece
    en seis frames seguidos. Sin deduplicar, el texto que se le pasa al LLM de
    síntesis queda dominado por repeticiones y el tono se infiere mal.
    Conserva la primera aparición, que es la que tiene el `at_second` útil.
    """
    seen: set[str] = set()
    out: list[TextBlock] = []
    for b in blocks:
        key = " ".join(b.text.lower().split())
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(b)
    return out
