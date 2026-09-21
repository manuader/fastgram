"""Motores de OCR — ADR-011 (PaddleOCR self-host).

El motor está detrás de un protocolo por dos razones concretas:

1. PaddleOCR pesa cientos de MB y no siempre instala limpio en la máquina de
   desarrollo. El servicio tiene que arrancar igual y DECIR que no puede leer,
   en vez de fallar al importar y dejar el stack sin levantar.
2. `AI-016` exige que un fallo de OCR degrade a `partial` y nunca aborte. Eso
   es más fácil de garantizar —y de testear— si el motor es reemplazable por
   uno que falla a propósito.

Por qué PaddleOCR y no Tesseract: el caso real es texto estilizado sobre video
(overlays de TikTok, miniaturas), donde Tesseract rinde mal. PaddleOCR es
Apache-2.0, así que el uso comercial no tiene reparo.
"""

from pathlib import Path
from typing import Protocol

from .models import TextBlock


class OcrEngine(Protocol):
    name: str

    def available(self) -> bool: ...

    def read(self, image_path: Path) -> list[TextBlock]:
        """Lee una imagen. Puede lanzar: el llamador degrada a `partial`."""
        ...


class UnavailableEngine:
    """Motor que declara no poder leer.

    No es un stub de relleno: es el comportamiento correcto cuando el deploy no
    tiene PaddleOCR. Devuelve vacío y `available() == False`, y el endpoint de
    salud lo publica. Sin esto, un deploy sin motor parece sano y degrada todas
    las altas a `partial` sin que nadie se entere.
    """

    name = "unavailable"

    def __init__(self, reason: str) -> None:
        self.reason = reason

    def available(self) -> bool:
        return False

    def read(self, image_path: Path) -> list[TextBlock]:
        raise RuntimeError(f"motor de OCR no disponible: {self.reason}")


class PaddleOcrEngine:
    """PaddleOCR. Carga perezosa: el modelo pesa y arrancar debe ser rápido."""

    name = "paddleocr"

    def __init__(self) -> None:
        self._ocr = None
        self._load_error: str | None = None

    def available(self) -> bool:
        try:
            import paddleocr  # noqa: F401
        except ImportError as e:
            self._load_error = str(e)
            return False
        return True

    def _engine(self):
        if self._ocr is None:
            from paddleocr import PaddleOCR

            # `use_angle_cls`: los overlays de TikTok aparecen rotados con
            # frecuencia. Sin esto se pierde una parte del texto que importa.
            self._ocr = PaddleOCR(use_angle_cls=True, lang="en", show_log=False)
        return self._ocr

    def read(self, image_path: Path) -> list[TextBlock]:
        result = self._engine().ocr(str(image_path), cls=True)
        blocks: list[TextBlock] = []
        # Forma de PaddleOCR: [[ [box, (texto, confianza)], ... ]]
        for page in result or []:
            for entry in page or []:
                box, (text, confidence) = entry[0], entry[1]
                xs = [int(p[0]) for p in box]
                ys = [int(p[1]) for p in box]
                blocks.append(
                    TextBlock(
                        text=text,
                        confidence=float(confidence),
                        box=(min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)),
                    )
                )
        return blocks


def build_engine() -> OcrEngine:
    """Elige el motor disponible al arrancar."""
    paddle = PaddleOcrEngine()
    if paddle.available():
        return paddle
    return UnavailableEngine(
        "paddleocr no está instalado (instalá el extra `ocr`: "
        "`uv pip install -e '.[ocr]'`)"
    )
