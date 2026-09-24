"""Instagram anónimo con instaloader — `PU-SCRAPE-001`, PRD `FR-011.3`, `D-13`.

**Sin ninguna cuenta logueada** (`D-13` corregida por el dueño el 2026-09-24:
tampoco una secundaria). Se usa `instaloader` como librería, nunca la CLI: el
`eval` que encontró la auditoría (`docs/AUDITORIA-SCRAPERS.md`) es la opción
`--filter` de la CLI y acá no se toca.

Versión fijada: **`instaloader==4.15.3`**. El commit auditado (`7efc78d`) es
el tag `v4.15.3` más un solo commit que cambia
`docs/codesnippets/615_import_firefox_session.py` (comparado con la API de
GitHub el 2026-09-24): el código de la librería es idéntico.

## Lo que se sabe que va a fallar, y cómo se diseñó alrededor

El modo anónimo **está degradado**: tira 429 seguido (issue #2726 de
instaloader). Por eso:

1. **Una llamada por perfil.** `Profile.from_username` pega a
   `api/v1/users/web_profile_info/`, que (según su propio docstring en 4.15.3)
   «returns the complete profile node (including the first page of posts)». Con
   `limit <= 12` se sirve de esa página y no hay segunda llamada.
2. **Cache en memoria** por `(usuario, límite)`, con TTL configurable.
3. **Ni un reintento adentro.** `max_connection_attempts=1`: con eso, un 429
   sale como `ConnectionException` cuyo `__cause__` es
   `TooManyRequestsException`, sin pasar por `RateController.handle_429` (que
   **duerme** minutos adentro del request HTTP). El rate controller propio,
   además, se niega a dormir más de unos segundos antes de una consulta.
4. **Enfriamiento después de un 429**: el siguiente pedido dentro de la
   ventana se contesta 429 sin tocar Instagram. La ventana se duplica con cada
   429 seguido, con techo. Insistir contra un 429 es la forma más rápida de
   que la IP quede marcada.
5. **Un pedido a la vez** (un `asyncio.Lock`): dos altas simultáneas no
   duplican la ráfaga.

Los códigos que salen de acá son estables y son lo único que ve el lado
TypeScript: `platform_rate_limited`, `profile_unavailable` (con `reason`
`not_found` o `private`), `platform_unavailable`, `extractor_unavailable` e
`invalid_username`. La excepción cruda de instaloader va al log, nunca al
cuerpo.

Todo lo que devuelve es **dato de un tercero** (bio y captions escritas por
quien sea): quien lo consume lo trata como dato, nunca como instrucción
(PRD §9.14, `P1-BRAND-019`). Este módulo no lo interpreta.
"""

from __future__ import annotations

import asyncio
import itertools
import logging
import re
import time
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Protocol

from pydantic import BaseModel, Field

log = logging.getLogger("vision.social.instagram")

#: Formato de usuario de Instagram: letras, números, punto y guion bajo, hasta
#: 30. Se valida antes de gastar una llamada.
USERNAME_RE = re.compile(r"^[A-Za-z0-9._]{1,30}$")

#: La primera página de posts que trae `web_profile_info`. Pedir más obliga a
#: una segunda consulta (`Profile.get_posts`, `count: 12` en 4.15.3).
FIRST_PAGE_POSTS = 12

#: Techo de ítems: el de `AI-016` (24 por análisis).
MAX_POSTS = 24


# ───────────────────────────────────────────────────────────────────────────
# Contrato HTTP
# ───────────────────────────────────────────────────────────────────────────


class InstagramProfileRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    limit: int = Field(default=FIRST_PAGE_POSTS, ge=0, le=MAX_POSTS)


class InstagramPost(BaseModel):
    shortcode: str
    permalink: str
    #: `GraphImage` → image, `GraphSidecar` → carousel, `GraphVideo` → video.
    kind: str
    caption: str | None = None
    hashtags: list[str] = []
    mentions: list[str] = []
    likes: int | None = None
    comments: int | None = None
    video_views: int | None = None
    posted_at: str | None = None
    #: Para OCR en memoria (`DATA-032`): no se guarda.
    media_url: str | None = None


class InstagramProfile(BaseModel):
    username: str
    full_name: str | None = None
    biography: str | None = None
    external_url: str | None = None
    business_category: str | None = None
    followers: int | None = None
    following: int | None = None
    media_count: int | None = None
    is_private: bool = False
    profile_pic_url: str | None = None


class InstagramProfileResponse(BaseModel):
    profile: InstagramProfile
    posts: list[InstagramPost] = []
    #: Si la lista de posts se cortó por un error después de leer el perfil.
    #: El perfil sirve igual: `FR-011.8` → `partial`.
    posts_error: str | None = None
    cached: bool = False


# ───────────────────────────────────────────────────────────────────────────
# Errores estables
# ───────────────────────────────────────────────────────────────────────────


class InstagramError(Exception):
    """Un error con código estable. Es lo único que cruza la frontera."""

    def __init__(
        self,
        code: str,
        status: int,
        message: str,
        *,
        reason: str | None = None,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.status = status
        self.message = message
        self.reason = reason
        self.retry_after = retry_after

    def body(self) -> dict[str, Any]:
        err: dict[str, Any] = {"code": self.code, "message": self.message}
        if self.reason is not None:
            err["reason"] = self.reason
        if self.retry_after is not None:
            err["retry_after"] = self.retry_after
        return {"error": err}


class WouldWait(Exception):
    """El rate controller se negó a dormir adentro de un request HTTP."""

    def __init__(self, seconds: float) -> None:
        super().__init__(f"instaloader quería esperar {seconds:.0f}s")
        self.seconds = seconds


def _names(exc: BaseException) -> set[str]:
    """Nombres de clase de la excepción y de toda su cadena de causas.

    Se clasifica **por nombre** y no con `isinstance` para que el mapeo no
    dependa de que instaloader esté instalado (el servicio arranca sin él) y
    para poder probarlo sin la librería. Los nombres son los de
    `instaloader/exceptions.py` en 4.15.3.
    """
    out: set[str] = set()
    seen: set[int] = set()
    cur: BaseException | None = exc
    while cur is not None and id(cur) not in seen:
        seen.add(id(cur))
        out.update(c.__name__ for c in type(cur).__mro__)
        cur = cur.__cause__ or cur.__context__
    return out


def classify(exc: BaseException) -> InstagramError:
    """Traduce una excepción de instaloader a un código estable."""
    if isinstance(exc, InstagramError):
        return exc
    names = _names(exc)
    if "WouldWait" in names or "TooManyRequestsException" in names:
        return InstagramError(
            "platform_rate_limited", 429, "Instagram is rate limiting anonymous reads."
        )
    if "PrivateProfileNotFollowedException" in names:
        return InstagramError(
            "profile_unavailable", 403, "The profile is private.", reason="private"
        )
    if "ProfileNotExistsException" in names or "QueryReturnedNotFoundException" in names:
        return InstagramError(
            "profile_unavailable", 404, "The profile does not exist.", reason="not_found"
        )
    if (
        "LoginRequiredException" in names
        or "QueryReturnedForbiddenException" in names
        or "AbortDownloadException" in names
    ):
        # Instagram pide login o un checkpoint a una lectura anónima. No hay
        # login que darle (`D-13`): para el que llama es «no disponible ahora».
        return InstagramError(
            "platform_unavailable",
            502,
            "Instagram refused an anonymous read.",
            reason="login_wall",
        )
    return InstagramError(
        "platform_unavailable", 502, "Instagram did not answer as expected."
    )


# ───────────────────────────────────────────────────────────────────────────
# Backend: lo único que habla con instaloader
# ───────────────────────────────────────────────────────────────────────────


class ProfileLike(Protocol):
    """Lo que se lee de `instaloader.Profile` (propiedades de 4.15.3)."""

    username: str
    full_name: str
    biography: str
    external_url: str | None
    business_category_name: str | None
    followers: int
    followees: int
    mediacount: int
    is_private: bool
    profile_pic_url: str

    def get_posts(self) -> Iterable[Any]: ...


class Backend(Protocol):
    def load_profile(self, username: str) -> ProfileLike: ...


class InstaloaderBackend:
    """El backend real. **Anónimo**: nunca llama a `login` ni carga sesiones."""

    def __init__(self, *, request_timeout: float, max_query_wait: float) -> None:
        import instaloader  # import perezoso: el servicio arranca sin la librería

        class _NoLongSleep(instaloader.RateController):
            # Documentado en `RateController` de 4.15.3 como el punto para
            # «raise a custom exception when the rate limit is hit».
            def sleep(self, secs: float) -> None:
                if secs > max_query_wait:
                    raise WouldWait(secs)
                time.sleep(secs)

        self._instaloader = instaloader
        self._loader = instaloader.Instaloader(
            quiet=True,
            download_pictures=False,
            download_videos=False,
            download_video_thumbnails=False,
            save_metadata=False,
            compress_json=False,
            max_connection_attempts=1,
            request_timeout=request_timeout,
            rate_controller=lambda ctx: _NoLongSleep(ctx),
        )

    def load_profile(self, username: str) -> ProfileLike:
        return self._instaloader.Profile.from_username(self._loader.context, username)


def build_backend(
    *, request_timeout: float = 20.0, max_query_wait: float = 5.0
) -> Backend | None:
    """El backend real, o `None` si instaloader no está instalado."""
    try:
        return InstaloaderBackend(
            request_timeout=request_timeout, max_query_wait=max_query_wait
        )
    except ImportError:
        return None


# ───────────────────────────────────────────────────────────────────────────
# Normalización
# ───────────────────────────────────────────────────────────────────────────

_KIND = {"GraphImage": "image", "GraphSidecar": "carousel", "GraphVideo": "video"}


def _opt_str(v: Any) -> str | None:
    return v if isinstance(v, str) and v.strip() != "" else None


def _opt_int(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def _iso(v: Any) -> str | None:
    if not isinstance(v, datetime):
        return None
    aware = v if v.tzinfo is not None else v.replace(tzinfo=UTC)
    return aware.astimezone(UTC).isoformat().replace("+00:00", "Z")


def normalize_profile(p: ProfileLike) -> InstagramProfile:
    return InstagramProfile(
        username=p.username,
        full_name=_opt_str(getattr(p, "full_name", None)),
        biography=_opt_str(getattr(p, "biography", None)),
        external_url=_opt_str(getattr(p, "external_url", None)),
        business_category=_opt_str(getattr(p, "business_category_name", None)),
        followers=_opt_int(getattr(p, "followers", None)),
        following=_opt_int(getattr(p, "followees", None)),
        media_count=_opt_int(getattr(p, "mediacount", None)),
        is_private=bool(getattr(p, "is_private", False)),
        profile_pic_url=_opt_str(getattr(p, "profile_pic_url", None)),
    )


def normalize_post(post: Any) -> InstagramPost:
    shortcode = str(post.shortcode)
    is_video = bool(getattr(post, "is_video", False))
    media = getattr(post, "video_url", None) if is_video else None
    return InstagramPost(
        shortcode=shortcode,
        permalink=f"https://www.instagram.com/p/{shortcode}/",
        kind=_KIND.get(getattr(post, "typename", ""), "video" if is_video else "image"),
        caption=_opt_str(getattr(post, "caption", None)),
        hashtags=[h for h in (getattr(post, "caption_hashtags", None) or []) if h],
        mentions=[m for m in (getattr(post, "caption_mentions", None) or []) if m],
        likes=_opt_int(getattr(post, "likes", None)),
        comments=_opt_int(getattr(post, "comments", None)),
        video_views=_opt_int(getattr(post, "video_view_count", None)),
        posted_at=_iso(getattr(post, "date_utc", None)),
        media_url=_opt_str(media) or _opt_str(getattr(post, "url", None)),
    )


def read_profile_sync(
    backend: Backend, username: str, limit: int
) -> InstagramProfileResponse:
    """Una lectura. Sincrónica: instaloader usa `requests`."""
    profile = backend.load_profile(username)
    normalized = normalize_profile(profile)
    if normalized.is_private or limit == 0:
        # Privado: sin posts que leer. `FR-011.9` → degradar a D; lo decide el
        # que llama con `is_private`.
        return InstagramProfileResponse(profile=normalized)
    posts: list[InstagramPost] = []
    posts_error: str | None = None
    try:
        for post in itertools.islice(profile.get_posts(), limit):
            posts.append(normalize_post(post))
    except Exception as exc:  # noqa: BLE001 — se clasifica y se degrada, no se oculta
        err = classify(exc)
        log.warning("posts de @%s cortados: %s (%r)", username, err.code, exc)
        posts_error = err.code
    return InstagramProfileResponse(
        profile=normalized, posts=posts, posts_error=posts_error
    )


# ───────────────────────────────────────────────────────────────────────────
# Servicio: cache, enfriamiento y un pedido a la vez
# ───────────────────────────────────────────────────────────────────────────


@dataclass
class _Entry:
    expires_at: float
    value: InstagramProfileResponse


class InstagramReader:
    def __init__(
        self,
        backend: Backend | None,
        *,
        cache_ttl_seconds: float,
        cooldown_base_seconds: float,
        cooldown_max_seconds: float,
        clock: Callable[[], float] = time.monotonic,
        run_sync: Callable[..., Any] | None = None,
    ) -> None:
        self._backend = backend
        self._ttl = cache_ttl_seconds
        self._cool_base = cooldown_base_seconds
        self._cool_max = cooldown_max_seconds
        self._clock = clock
        self._run_sync = run_sync
        self._cache: dict[tuple[str, int], _Entry] = {}
        self._cooldown_until = 0.0
        self._strikes = 0
        self._lock = asyncio.Lock()

    @property
    def available(self) -> bool:
        return self._backend is not None

    def _cached(self, key: tuple[str, int]) -> InstagramProfileResponse | None:
        entry = self._cache.get(key)
        if entry is None:
            return None
        if entry.expires_at <= self._clock():
            self._cache.pop(key, None)
            return None
        return entry.value.model_copy(update={"cached": True})

    def _cooldown_error(self) -> InstagramError | None:
        remaining = self._cooldown_until - self._clock()
        if remaining <= 0:
            return None
        return InstagramError(
            "platform_rate_limited",
            429,
            "Instagram is rate limiting anonymous reads.",
            retry_after=max(1, int(remaining + 0.999)),
        )

    def _strike(self) -> int:
        self._strikes += 1
        window = min(self._cool_max, self._cool_base * (2 ** (self._strikes - 1)))
        self._cooldown_until = self._clock() + window
        return int(window)

    async def read(self, username: str, limit: int) -> InstagramProfileResponse:
        if not USERNAME_RE.match(username):
            raise InstagramError("invalid_username", 400, "Not an Instagram username.")
        if self._backend is None:
            raise InstagramError(
                "extractor_unavailable",
                503,
                "instaloader is not installed in this vision service.",
            )
        key = (username.lower(), limit)
        hit = self._cached(key)
        if hit is not None:
            return hit

        async with self._lock:
            # Otro pedido pudo haberlo llenado mientras éste esperaba el lock.
            hit = self._cached(key)
            if hit is not None:
                return hit
            cooling = self._cooldown_error()
            if cooling is not None:
                raise cooling
            backend = self._backend
            try:
                if self._run_sync is not None:
                    result = await self._run_sync(
                        read_profile_sync, backend, key[0], limit
                    )
                else:
                    result = await asyncio.to_thread(
                        read_profile_sync, backend, key[0], limit
                    )
            except Exception as exc:  # noqa: BLE001 — se traduce a código estable
                err = classify(exc)
                if err.code == "platform_rate_limited":
                    err.retry_after = self._strike()
                log.warning("instagram @%s: %s (%r)", key[0], err.code, exc)
                raise err from exc

            if result.posts_error == "platform_rate_limited":
                # El perfil llegó pero la segunda página no: igual cuenta como
                # 429 para el enfriamiento del próximo pedido.
                self._strike()
            else:
                self._strikes = 0
            # Un resultado cortado no se cachea: el próximo pedido, pasado el
            # enfriamiento, puede traerlo entero.
            if result.posts_error is None:
                self._cache[key] = _Entry(self._clock() + self._ttl, result)
            return result
