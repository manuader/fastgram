"""La regla de AI-016: un fallo de OCR degrada a `partial`, NUNCA aborta.

Estos tests son la red de esa regla. Si alguien deja que una excepción del
motor suba, acá se rompe.
"""

from pathlib import Path

import pytest

from app.models import OcrRequest, OcrStatus, TextBlock
from app.service import analyse_image, analyse_video


class MotorQueExplota:
    name = "explota"

    def available(self) -> bool:
        return True

    def read(self, image_path: Path) -> list[TextBlock]:
        raise RuntimeError("el modelo se cayó")


class MotorQueLee:
    name = "lee"

    def __init__(self, texto: str = "GEN Z COUPLES LOSING IT OVER THIS"):
        self.texto = texto

    def available(self) -> bool:
        return True

    def read(self, image_path: Path) -> list[TextBlock]:
        return [TextBlock(text=self.texto, confidence=0.94)]


async def test_fallo_de_ocr_sobre_imagen_da_partial_y_no_lanza(tmp_path):
    img = tmp_path / "x.jpg"
    img.write_bytes(b"no importa")

    res = await analyse_image(MotorQueExplota(), img, OcrRequest(url="x"))

    assert res.status is OcrStatus.PARTIAL
    assert res.blocks == []
    assert res.reason is not None
    # Lo que se devuelve hacia afuera no puede contener la excepción cruda.
    assert "el modelo se cayó" not in res.reason


async def test_video_sin_frames_extraibles_da_partial(tmp_path):
    # Un archivo que no es video: ffmpeg no va a poder sacar ni un frame.
    fake = tmp_path / "roto.mp4"
    fake.write_bytes(b"esto no es un video")

    res = await analyse_video(MotorQueLee(), fake, OcrRequest(url="x"))

    assert res.status is OcrStatus.PARTIAL
    assert res.frames_analysed == 0


async def test_lectura_exitosa_detecta_idioma(tmp_path):
    img = tmp_path / "x.jpg"
    img.write_bytes(b"no importa")

    res = await analyse_image(
        MotorQueLee("the best thing you will read about this today"),
        img,
        OcrRequest(url="x"),
    )

    assert res.status is OcrStatus.OK
    assert res.detected_language == "en"
    assert res.frames_analysed == 1


@pytest.mark.parametrize("every", [0.5, 2.0, 30.0])
def test_el_muestreo_acepta_el_rango_del_contrato(every):
    assert OcrRequest(url="x", sample_every_seconds=every).sample_every_seconds == every


def test_el_muestreo_rechaza_fuera_de_rango():
    with pytest.raises(ValueError):
        OcrRequest(url="x", sample_every_seconds=0)
    with pytest.raises(ValueError):
        OcrRequest(url="x", max_frames=61)
