@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM  PASO 1 — Volcar la BD de TiDB Cloud a docker/init/dump.sql
REM  Ejecutar ANTES de docker-compose up
REM ─────────────────────────────────────────────────────────────────────────────
echo.
echo  Volcando base de datos desde TiDB Cloud...
echo  (Requiere que el archivo .env tenga la password de DB_PASSWORD)
echo.

node scripts/volcar-bd.js

pause
