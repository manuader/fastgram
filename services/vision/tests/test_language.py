from app.language import detect_language


def test_ingles_y_espanol_se_distinguen():
    assert detect_language("This is the caption that you should read for more") == "en"
    assert detect_language("Esta es la descripción que tenés que leer para más") == "es"


def test_texto_corto_no_afirma_nada():
    # Tres palabras no alcanzan. None es la respuesta correcta, no "en".
    assert detect_language("buy now") is None
    assert detect_language("") is None
    assert detect_language("   ") is None


def test_escritura_no_latina_gana_directo():
    assert detect_language("これは日本語のキャプションです") == "ja"
    assert detect_language("это подпись на русском языке") == "ru"


def test_un_hashtag_extranjero_no_cambia_el_idioma():
    # El caso real: caption en inglés con un hashtag en japonés.
    texto = "the best coffee you will find with this blend today #日本"
    assert detect_language(texto) == "en"


def test_sin_marcadores_devuelve_none():
    assert detect_language("zzz qqq xxx www vvv") is None
