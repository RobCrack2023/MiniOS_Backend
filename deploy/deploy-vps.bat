@echo off
rem ============================================================
rem  Instala o actualiza MiniOS Backend en la VPS por SSH.
rem  Sube setup-vps.sh y lo ejecuta alli como root.
rem  Antes de tocar nada guarda una copia de la base de datos en
rem  deploy\backups\ de este PC (fuera de git: tiene datos reales).
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

set "SSH_PORT=22222"
set /p "SSH_PORT=Puerto SSH [22222]: "

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
rem Con un puerto distinto del 22, known_hosts guarda la huella como [host]:puerto
if /i "%RESET_KEY%"=="s" (
  ssh-keygen -R "%VPS_HOST%" >nul 2>&1
  ssh-keygen -R "[%VPS_HOST%]:%SSH_PORT%" >nul 2>&1
)

echo.
echo ---- 1/2 Subiendo el script y copiando la base de datos a este PC ----
echo      (SSH te pedira la contrasena)
if not exist "backups" mkdir "backups"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd_HHmmss"') do set "TS=%%i"
set "BACKUP=backups\minios_%VPS_HOST%_%TS%.db"
set "BACKUP_LOG=%BACKUP%.log"

rem Una sola conexion para no pedir otra contrasena: la entrada sube el script,
rem la salida trae la copia de la base de datos y los mensajes van al .log.
rem sed quita los CRLF por si git convirtio el .sh al formato de Windows.
ssh -p %SSH_PORT% -o StrictHostKeyChecking=accept-new %VPS_USER%@%VPS_HOST% "cat > /tmp/minios-setup.sh && sed -i 's/\r$//' /tmp/minios-setup.sh && if [ $(id -u) -eq 0 ]; then bash /tmp/minios-setup.sh --backup-db; else sudo -n bash /tmp/minios-setup.sh --backup-db; fi" < setup-vps.sh > "%BACKUP%" 2> "%BACKUP_LOG%"
set "RC=%errorlevel%"
if "%RC%"=="0" goto check_backup
if "%RC%"=="3" goto no_db
if "%RC%"=="255" goto ssh_failed
goto backup_failed

:check_backup
rem La copia solo vale si su SHA-256 coincide con el que calculo la VPS
powershell -NoProfile -Command "$m = Select-String -Path '%BACKUP_LOG%' -Pattern '^SHA256=([0-9a-f]{64})'; $h = (Get-FileHash '%BACKUP%' -Algorithm SHA256).Hash.ToLower(); if ($m -and $m.Matches[0].Groups[1].Value -eq $h) { '     Copia verificada: {0} ({1:N0} KB)' -f (Resolve-Path '%BACKUP%'), ((Get-Item '%BACKUP%').Length / 1KB); exit 0 } else { '     La copia llego danada (el SHA-256 no coincide).'; exit 1 }"
if errorlevel 1 goto backup_failed
del "%BACKUP_LOG%" >nul 2>&1
goto install

:no_db
del "%BACKUP%" "%BACKUP_LOG%" >nul 2>&1
echo      No hay base de datos en la VPS todavia: instalacion nueva, nada que copiar.
goto install

:ssh_failed
type "%BACKUP_LOG%" 2>nul
del "%BACKUP%" "%BACKUP_LOG%" >nul 2>&1
echo.
echo No se pudo conectar por SSH.
pause
exit /b 1

:backup_failed
type "%BACKUP_LOG%" 2>nul
del "%BACKUP%" "%BACKUP_LOG%" >nul 2>&1
echo.
echo No se pudo copiar la base de datos a este PC.
echo Si el usuario SSH no es root, sudo necesita contrasena: usa root.
set "GO_ON=n"
set /p "GO_ON=Continuar sin copia local? La VPS hace igualmente su propia copia. (s/N): "
if /i not "%GO_ON%"=="s" (pause & exit /b 1)

:install
echo.
echo ---- 2/2 Instalando (tarda 5-10 minutos; SSH pedira la contrasena otra vez) ----
ssh -t -p %SSH_PORT% %VPS_USER%@%VPS_HOST% "if [ $(id -u) -eq 0 ]; then bash /tmp/minios-setup.sh '%DOMAIN%' '%EMAIL%' '%TOKEN%' '%BRANCH%' '%SSH_PORT%'; else sudo bash /tmp/minios-setup.sh '%DOMAIN%' '%EMAIL%' '%TOKEN%' '%BRANCH%' '%SSH_PORT%'; fi"
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
