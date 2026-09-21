"""Extracción de frames de video para OCR.

Trampa documentada, que ya nos costó una tarde en este proyecto: muchos builds
de FFmpeg vienen SIN el filtro `drawtext` (requiere libfreetype). Cuando falta,
ffmpeg no avisa con claridad — escribe "Filter not found" y produce CERO frames
con código de salida 0. Un pipeline que no revise cuántos archivos salieron
interpreta eso como "el video no tenía texto".

Por eso acá: (a) no se usa `drawtext` para nada, el timestamp se deriva del
índice del frame; (b) después de extraer se CUENTA lo que salió y se falla
explícito si son cero. Ver docs/HANDOFF.md §7.
"""

import asyncio
import shutil
from dataclasses import dataclass
from pathlib import Path


class FrameExtractionError(RuntimeError):
    """FFmpeg no pudo producir frames. El llamador degrada a `partial`."""


@dataclass(frozen=True)
class ExtractedFrame:
    path: Path
    at_second: float


def ffmpeg_available() -> bool:
    return shutil.which("ffmpeg") is not None


async def extract_frames(
    video_path: Path,
    out_dir: Path,
    every_seconds: float = 2.0,
    max_frames: int = 12,
) -> list[ExtractedFrame]:
    """Muestrea un frame cada `every_seconds`, hasta `max_frames`."""
    if not ffmpeg_available():
        raise FrameExtractionError("ffmpeg no está en el PATH")

    out_dir.mkdir(parents=True, exist_ok=True)
    pattern = str(out_dir / "f_%04d.jpg")

    proc = await asyncio.create_subprocess_exec(
        "ffmpeg",
        "-nostdin",
        "-loglevel",
        "error",
        "-i",
        str(video_path),
        # Sin drawtext. El timestamp se calcula del índice; ver el docstring.
        "-vf",
        f"fps=1/{every_seconds}",
        "-frames:v",
        str(max_frames),
        "-q:v",
        "3",
        "-y",
        pattern,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    _, stderr = await proc.communicate()

    frames = sorted(out_dir.glob("f_*.jpg"))

    # El chequeo que importa: ffmpeg puede salir con 0 y no escribir nada.
    if not frames:
        detail = stderr.decode("utf-8", "replace").strip() or "sin detalle"
        raise FrameExtractionError(
            f"ffmpeg no produjo frames (código {proc.returncode}): {detail}"
        )

    return [
        # El primer frame de `fps=1/N` cae en t=0, el segundo en t=N.
        ExtractedFrame(path=p, at_second=i * every_seconds)
        for i, p in enumerate(frames)
    ]
