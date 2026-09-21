from app.models import OcrStatus, TextBlock
from app.service import _build_response


def test_un_overlay_repetido_en_varios_frames_cuenta_una_vez():
    # Un overlay de TikTok dura ~6 s: a 1 frame cada 2 s aparece tres veces.
    # Sin deduplicar, el texto que ve el LLM de síntesis queda dominado por
    # repeticiones y el tono se infiere mal.
    blocks = [
        TextBlock(text="POV: you just found it", confidence=0.9, at_second=0.0),
        TextBlock(text="POV: you just found it", confidence=0.9, at_second=2.0),
        TextBlock(text="pov: You Just Found It", confidence=0.88, at_second=4.0),
        TextBlock(text="link in bio", confidence=0.8, at_second=6.0),
    ]
    res = _build_response(blocks, frames=4, status=OcrStatus.OK)

    assert len(res.blocks) == 2
    # Conserva la primera aparición: es la que tiene el at_second útil.
    assert res.blocks[0].at_second == 0.0


def test_el_idioma_ignora_los_bloques_de_baja_confianza():
    # Una marca de agua mal leída no debería decidir el idioma de la marca.
    blocks = [
        TextBlock(text="que de la por para con una este", confidence=0.2),
        TextBlock(text="the best thing you will read with this today", confidence=0.95),
    ]
    res = _build_response(blocks, frames=1, status=OcrStatus.OK)
    assert res.detected_language == "en"
