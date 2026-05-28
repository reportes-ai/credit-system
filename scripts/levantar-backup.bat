@echo off
REM ─────────────────────────────────────────────────────────────────────────────
REM  LEVANTAR APP LOCAL CON DOCKER
REM  Requisito: Docker Desktop instalado y corriendo
REM ─────────────────────────────────────────────────────────────────────────────

IF NOT EXIST "docker\init\dump.sql" (
  echo.
  echo  FALTA el volcado de base de datos.
  echo  Ejecuta primero:  scripts\volcar-bd.bat
  echo.
  pause
  exit /b 1
)

echo.
echo  Levantando contenedores...
docker-compose up -d --build

echo.
echo  Esperando que MySQL arranque...
timeout /t 15 /nobreak > nul

echo.
echo  ================================================================
echo   App corriendo en:  http://localhost:3000
echo   MySQL en puerto :  3307  (usuario: root / pass: credit1234)
echo  ================================================================
echo.
echo  Para detener:   docker-compose down
echo  Para ver logs:  docker-compose logs -f app
echo.
pause
