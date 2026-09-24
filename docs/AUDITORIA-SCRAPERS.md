# Auditoría de los scrapers — 2026-09-24

Pedido del dueño: revisar a mano que los scrapers elegidos (`PLAN-USO-PERSONAL.md` §6.1) no tengan
malware ni prompt injection antes de instalarlos. La skill "spector" de NVIDIA no existe en esta
máquina. La revisión la hizo el coordinador con clones `--depth 1` en un directorio temporal: **sin
instalar ni ejecutar nada**.

## Qué se buscó

- Ejecución dinámica u ofuscada: `exec`/`eval`, `__import__`, `marshal`/`pickle.loads`,
  `base64`/`codecs.decode` seguidos de ejecución, y cadenas codificadas de más de 300 caracteres.
- Procesos y shell: `subprocess`, `os.system`, `popen`, `pty`.
- Acceso a lugares sensibles: `~/.ssh`, `~/.aws`, keychain, crontab, LaunchAgents y los rc del shell.
- Destinos de red hardcodeados (todas las URLs del código de la librería, contadas).
- Imágenes base y `RUN curl|sh` en los Dockerfiles; capabilities y puertos en compose.
- Texto dirigido a agentes de IA ("ignore previous instructions", "you are…", `<system>`, menciones a
  Claude/OpenAI) en código, docs, JSON y YAML.

## Resultado

| Repo (commit) | Veredicto | Hallazgos, todos explicados |
|---|---|---|
| **Evil0ctal/Douyin_TikTok_Download_API** (`737bf3d`, 2026-09-22) | **Sin señales de malware** | Ni `exec` ni `eval`, ni subprocess, ni blobs. Los hosts son TikTok y Douyin, más estos, todos explicados: `ipinfo.io` e `ipify` son el probe opcional de proxies (en `GEO_PROBE_URL`, se apaga dejándolo vacío); `api.telegram.org` es un canal de alertas **opt-in** que exige `token` y `chat_id`; `icloud.com` es un link a un Atajo de iOS. El contenedor del navegador lleva `cap_add: SYS_ADMIN` con `cap_drop: ALL` y `no-new-privileges`: es lo estándar para el sandbox de Chromium. El puerto se publica en `127.0.0.1` por defecto. Imágenes base oficiales: `python:*-slim-bookworm`, `node:22-alpine`, `golang:1.27-alpine`, `uv`, `timescaledb-ha`, `redis:8-alpine`. |
| **instaloader** (`7efc78d`, 2026-09-06) | **Sin señales de malware** | Hay un `eval` en `__main__.py:80`, pero es la opción `--filter` de la CLI: compila una expresión que escribe el propio usuario y pasa por un transformador de AST. **No se usa**: vamos a llamar a la librería, no a la CLI con filtros. `subprocess` aparece sólo en el script que arma el `.exe` de Windows y en la config de la documentación. Hosts: instagram.com y GitHub. |
| **crawl4ai** (`86e6464`, 2026-09-23) | **Sin señales de malware** | `subprocess` sirve para lanzar el navegador, Xvfb/noVNC (modo Docker) y `vm_stat`. Hay un `git clone` en `model_loader.py`, pero es una descarga opcional de modelos para una estrategia de extracción que no vamos a usar. Las menciones a analytics son una **lista de bloqueo** de trackers, no telemetría. |
| **yt-dlp** | **No auditado línea por línea** (son cientos de extractores) | Se instala desde **Homebrew**, que entrega un binario de la release oficial. Se confía en la procedencia, no en la lectura. |

**Prompt injection:** en ningún repo hay texto dirigido a un agente. Evil0ctal menciona "Claude
Code" en docs y locales, pero es la documentación de su servidor MCP y no contiene instrucciones
al lector.

## Lo que la auditoría NO cubre, y el riesgo real

- **Dependencias transitivas** (los `uv.lock` y `requirements` de cada uno) **no se auditaron**.
- **El riesgo de prompt injection real está en los *datos*, no en el código**: la bio, los
  captions y el HTML que traen estos scrapers entran al LLM. Eso lo cubre la suite de bios
  adversariales (`P1-BRAND-019`) y la regla de tratar todo lo scrapeado como dato, nunca como
  instrucción. Cualquier extractor nuevo tiene que pasar por esa suite.
- Se auditó un commit concreto. **Hay que fijar esas versiones** al instalar: en Docker, por
  digest o por tag de release; en pip, con la versión exacta.
