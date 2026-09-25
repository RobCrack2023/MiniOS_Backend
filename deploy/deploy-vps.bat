@echo off
rem ============================================================
rem  Instala o actualiza MiniOS Backend en la VPS por SSH.
rem  Sube setup-vps.sh y lo ejecuta alli como root.
rem  Se puede volver a ejecutar: conserva base de datos y .env.
rem ============================================================
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"

where ssh >nul 2>&1
if errorlevel 1 (
  echo No se encontro ssh.
  echo Instalalo en: Configuracion ^> Sistema ^> Caracteristicas opcionales ^> Cliente OpenSSH
  pause
  exit /b 1
)

if not exist "setup-vps.sh" (
  echo Falta setup-vps.sh junto a este archivo.
  pause
  exit /b 1
)

echo.
echo ==== MiniOS Backend - deploy en VPS ====
echo.

set "VPS_HOST="
set /p "VPS_HOST=IP de la VPS: "
if "%VPS_HOST%"=="" (echo La IP es obligatoria. & pause & exit /b 1)

set "VPS_USER=root"
set /p "VPS_USER=Usuario SSH [root]: "

set "DOMAIN=minios.iot-robotics.cl"
set /p "DOMAIN=Dominio del backend [minios.iot-robotics.cl]: "

set "EMAIL="
set /p "EMAIL=Email para el certificado HTTPS (avisos de Let's Encrypt): "
if "%EMAIL%"=="" (echo El email es obligatorio. & pause & exit /b 1)

echo.
echo Token de dispositivo (DEVICE_TOKEN): lo que los ESP32 envian para conectarse.
echo   Enter = generar uno nuevo  ^|  pega el anterior para no reconfigurar los ESP32  ^|  - = sin token
set "TOKEN="
set /p "TOKEN=Token: "

set "BRANCH=main"
set /p "BRANCH=Rama de git a desplegar [main]: "

echo.
echo Si la VPS se reformateo con la misma IP, SSH rechazara la conexion porque
echo su huella cambio. Borrar la huella antigua es seguro si TU reinstalaste la VPS.
set "RESET_KEY=n"
set /p "RESET_KEY=Borrar la huella antigua de %VPS_HOST% en known_hosts? (s/N): "
if /i "%RESET_KEY%"=="s" ssh-keygen -R "%VPS_HOST%" >nul 2>&1

echo.
echo ---- 1/2 Subiendo el script (SSH te pedira la contrasena) ----
ssh -o StrictHostKeyChecking=accept-new %VPS_USER%@%VPS_HOST% "cat > /tmp/minios-setup.sh" < setup-vps.sh
if errorlevel 1 (
  echo.
  echo No se pudo conectar o subir el script.
  pause
  exit /b 1
)

echo.
echo ---- 2/2 Instalando (tarda 5-10 minutos; SSH pedira la contrasena otra vez) ----
rem sed quita los CRLF por si git convirtio el .sh al formato de Windows
ssh -t %VPS_USER%@%VPS_HOST% "sed -i 's/\r$//' /tmp/minios-setup.sh && if [ $(id -u) -eq 0 ]; then bash /tmp/minios-setup.sh '%DOMAIN%' '%EMAIL%' '%TOKEN%' '%BRANCH%'; else sudo bash /tmp/minios-setup.sh '%DOMAIN%' '%EMAIL%' '%TOKEN%' '%BRANCH%'; fi"
if errorlevel 1 (
  echo.
  echo La instalacion termino con errores. Revisa los mensajes de arriba.
  echo Se puede volver a ejecutar este .bat sin perder datos.
  pause
  exit /b 1
)

echo.
echo Listo. Guarda la contrasena de admin y el token que aparecen arriba.
pause
