"""Lectura de perfiles sociales sin login — `PU-SCRAPE-001`, PRD `FR-011.3`, `D-13`.

Vive en este servicio y no en el worker porque la herramienta elegida
(`instaloader`, `PLAN-USO-PERSONAL.md` §6.1) es Python. Sin estado propio más
allá de un cache en memoria: si el proceso se reinicia, se pierde, y está bien.
"""
