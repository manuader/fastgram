"""Contrato HTTP del servicio de visión.

Los nombres de campo son los que consume el adaptador `Ocr` del lado
TypeScript. Cambiarlos es un breaking change entre servicios.
"""

from enum import StrEnum

from pydantic import BaseModel, Field


class OcrStatus(StrEnum):
    """Estado de un análisis.

    `PARTIAL` no es un detalle: `AI-016` exige que un fallo de OCR degrade a
    parcial y **nunca** aborte el análisis de marca. Un alta que se cae entera
    porque una miniatura no se pudo leer es peor producto que un perfil con un
    campo menos.
    """

    OK = "ok"
    PARTIAL = "partial"
    FAILED = "failed"


class TextBlock(BaseModel):
    text: str
    confidence: float = Field(ge=0.0, le=1.0)
    #: Caja en píxeles [x, y, ancho, alto]. Sirve para saber si el texto es un
    #: overlay grande (el mensaje) o una marca de agua chica (ruido).
    box: tuple[int, int, int, int] | None = None
    #: Segundo del video del que salió este bloque. None si vino de una imagen.
    at_second: float | None = None


class OcrRequest(BaseModel):
    #: URL del objeto a leer. Siempre del Media Bank o del snapshot; nunca
    #: una URL arbitraria (PRD §6: se rechaza antes de empezar).
    url: str
    #: Para video: cada cuántos segundos muestrear un frame.
    sample_every_seconds: float = Field(default=2.0, gt=0, le=30)
    #: Tope de frames por ítem. Protege el costo: `AI-016` limita a 24 ítems
    #: por análisis, pero un video largo podría generar cientos de frames.
    max_frames: int = Field(default=12, ge=1, le=60)


class OcrResponse(BaseModel):
    status: OcrStatus
    blocks: list[TextBlock] = []
    #: Idioma detectado del texto extraído, ISO 639-1. None si no alcanzó.
    #: `AI-016`: el tono se registra en el idioma original, sin traducir.
    detected_language: str | None = None
    #: Qué salió mal, cuando el estado es PARTIAL o FAILED. Legible por humanos.
    #: Nunca contiene la excepción cruda del motor: eso va al log.
    reason: str | None = None
    frames_analysed: int = 0

    @property
    def full_text(self) -> str:
        return "\n".join(b.text for b in self.blocks)


class HealthResponse(BaseModel):
    status: str
    service: str
    #: Si el motor de OCR está realmente disponible. Que el servicio responda
    #: no significa que pueda leer nada: sin esto, un deploy sin PaddleOCR
    #: parece sano y degrada todas las altas a `partial` en silencio.
    ocr_engine: str
    ocr_available: bool
