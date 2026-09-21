# Servicio de visión. Escala aparte del resto (IMPL §2.2).
FROM python:3.12-slim

# ffmpeg es dependencia dura: sin él no hay OCR sobre video.
# libgl1 y libglib2.0-0 los pide PaddleOCR (OpenCV por debajo).
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libgl1 libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY pyproject.toml ./
COPY app ./app

RUN pip install --no-cache-dir -e ".[ocr]"

EXPOSE 8000
# Un worker por contenedor: el modelo de OCR ocupa memoria y duplicarlo dentro
# del mismo contenedor no compra nada. Se escala con réplicas.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
