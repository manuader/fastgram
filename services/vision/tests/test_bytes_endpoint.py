"""`POST /ocr/bytes` — la ruta que el adaptador `Ocr` necesita de verdad.

Por qué existe esta ruta y no alcanzaba con la de URL: el puerto `Ocr` pasa
**bytes**, porque `DATA-032` y `FR-011` dicen que los binarios de terceros no
se persisten — se procesan en memoria y se descartan. Un servicio que sólo
acepta URLs obliga a que alguien haya guardado el binario en algún lado
primero, que es justo lo que la regla prohíbe.

Sin esta ruta, el adaptador levantaba un servidor HTTP efímero en loopback y
se publicaba los bytes a sí mismo. Anda en desarrollo y **deja de andar apenas
los dos procesos vivan en contenedores distintos**, que es como van a correr.
"""

from fastapi.testclient import TestClient

from app.main import _suffix_for, app


def test_lee_bytes_sin_descargar_nada():
    # Sin motor de OCR, el resultado correcto es `partial` — no un 500.
    with TestClient(app) as client:
        r = client.post(
            "/ocr/bytes",
            content=b"no es una imagen real",
            headers={"X-Media-Content-Type": "image/png"},
        )
    assert r.status_code == 200
    assert r.json()["status"] == "partial"


def test_un_cuerpo_vacio_es_400():
    with TestClient(app) as client:
        r = client.post("/ocr/bytes", content=b"")
    assert r.status_code == 400


def test_un_video_sin_frames_degrada_a_partial():
    with TestClient(app) as client:
        r = client.post(
            "/ocr/bytes",
            content=b"tampoco es un video",
            headers={"X-Media-Content-Type": "video/mp4"},
        )
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "partial"
    assert body["frames_analysed"] == 0


def test_la_ruta_por_url_sigue_existiendo():
    # El Media Bank propio sí tiene el objeto en nuestro storage: ahí la URL
    # es lo correcto y no hay que mover bytes por el cuerpo.
    with TestClient(app) as client:
        r = client.post("/ocr", json={"url": "http://localhost:9/nada.jpg"})
    assert r.status_code == 200
    assert r.json()["status"] == "partial"


def test_el_content_type_decide_la_extension():
    # ffmpeg y sharp la miran; sin extensión correcta un mp4 se trata como
    # imagen y el análisis falla por la razón equivocada.
    assert _suffix_for("image/png") == ".png"
    assert _suffix_for("video/quicktime") == ".mov"
    assert _suffix_for("image/jpeg; charset=binary") == ".jpg"
    assert _suffix_for(None) == ".bin"
    assert _suffix_for("application/octet-stream") == ".bin"
