"""Detección de idioma del texto extraído.

Por qué está acá y no del lado del LLM: `AI-016` dice que el tono se registra
en el idioma original y no se traduce. Para eso hay que saber cuál es antes de
pasarle el texto al modelo de síntesis. Y para `FR-011` hay que poder decirle
al usuario "analicé una cuenta en portugués" en vez de devolver un perfil en
inglés sin avisar.

Implementación deliberadamente chica: n-gramas de caracteres sobre un conjunto
de marcadores por idioma. No compite con una librería dedicada, pero no agrega
una dependencia de 50 MB para resolver "¿es español o inglés?" sobre captions
de dos líneas. Si hiciera falta más precisión, esto es un punto de reemplazo
obvio y aislado.
"""

import re
import unicodedata

#: Palabras función. Se eligen por ser frecuentes y poco prestables entre
#: idiomas; "the" casi nunca aparece en un texto español, "que" casi nunca en
#: uno inglés.
_MARKERS: dict[str, frozenset[str]] = {
    "en": frozenset(
        "the and you for with this that your from have are not but was "
        "all just like what when out get how can now".split()
    ),
    "es": frozenset(
        "que de la el los las por para con una este esta como más pero "
        "todo cuando muy sin sobre también hasta desde".split()
    ),
    "pt": frozenset(
        "que de uma para com não por mais como mas você isso são "
        "então até quando muito também sobre".split()
    ),
    "fr": frozenset(
        "les des une pour avec pas que vous dans sur plus est sont "
        "mais tout comme quand très aussi".split()
    ),
    "de": frozenset(
        "und die der das nicht mit ist auf für von den ein eine auch "
        "aber wenn wie noch nur sehr".split()
    ),
    "it": frozenset(
        "che di per con non una come più sono anche questo quando "
        "molto solo dopo tutto essere".split()
    ),
}

#: Rangos de escritura no latina. Si pesan lo suficiente, ganan directo:
#: no tiene sentido buscar "the" en un texto en japonés.
_SCRIPT_RANGES: list[tuple[str, tuple[int, int]]] = [
    ("ja", (0x3040, 0x30FF)),  # hiragana + katakana
    ("ko", (0xAC00, 0xD7AF)),  # hangul
    ("ru", (0x0400, 0x04FF)),  # cirílico
    ("ar", (0x0600, 0x06FF)),  # árabe
    ("hi", (0x0900, 0x097F)),  # devanágari
    ("th", (0x0E00, 0x0E7F)),  # tailandés
    ("zh", (0x4E00, 0x9FFF)),  # han
]

_WORD_RE = re.compile(r"[^\W\d_]+", re.UNICODE)

#: Debajo de esto no afirmamos nada. Una caption de tres palabras no alcanza
#: para decidir, y equivocarse acá contamina el `toneOfVoice` de toda la marca.
_MIN_WORDS = 4


def detect_language(text: str) -> str | None:
    """Devuelve ISO 639-1, o None si no hay señal suficiente.

    None es una respuesta válida y esperada. Es preferible a adivinar: quien
    consume esto tiene que poder distinguir "es inglés" de "no sé".
    """
    if not text or not text.strip():
        return None

    script = _dominant_script(text)
    if script is not None:
        return script

    words = [w.lower() for w in _WORD_RE.findall(text)]
    if len(words) < _MIN_WORDS:
        return None

    scores = {
        lang: sum(1 for w in words if w in markers) for lang, markers in _MARKERS.items()
    }
    best = max(scores, key=lambda k: scores[k])
    if scores[best] == 0:
        return None

    # Empate: sin desempate no afirmamos. Pasa con textos cortos que comparten
    # préstamos ("no", "ok") entre idiomas romances.
    ordered = sorted(scores.values(), reverse=True)
    if len(ordered) > 1 and ordered[0] == ordered[1]:
        return None

    return best


def _dominant_script(text: str) -> str | None:
    """Idioma implícito por el sistema de escritura, si domina el texto."""
    letters = [c for c in text if unicodedata.category(c).startswith("L")]
    if not letters:
        return None

    counts: dict[str, int] = {}
    for ch in letters:
        cp = ord(ch)
        for lang, (lo, hi) in _SCRIPT_RANGES:
            if lo <= cp <= hi:
                counts[lang] = counts.get(lang, 0) + 1
                break

    if not counts:
        return None
    lang = max(counts, key=lambda k: counts[k])
    # Un hashtag en japonés dentro de un texto inglés no lo vuelve japonés.
    return lang if counts[lang] / len(letters) >= 0.3 else None
