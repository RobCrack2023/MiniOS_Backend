#!/usr/bin/env bash
#
# Instala MiniOS Backend en un Ubuntu/Debian recién instalado:
# Node.js + PM2 + nginx (proxy con WebSocket) + firewall + HTTPS con Let's Encrypt.
#
# Se puede volver a ejecutar: actualiza el código y conserva la base de datos,
# el .env, las grabaciones y la configuración HTTPS que dejó certbot.
#
# Uso (como root):  bash setup-vps.sh <dominio> <email> [device_token] [rama] [puerto_ssh]
#   device_token vacío = generar uno nuevo · "-" = sin token
#
#   bash setup-vps.sh --backup-db   escribe en stdout una copia de minios.db
#                                   (sale con 3 si todavía no hay base de datos)
#
set -euo pipefail

REPO_URL="https://github.com/RobCrack2023/MiniOS_Backend.git"
APP_USER="minios"
APP_HOME="/home/$APP_USER"
APP_DIR="$APP_HOME/MiniOS_Backend"
APP_PORT=3001
NODE_MAJOR=22   # LTS vigente (Node 20 dejó de tener soporte en abril de 2026)

# Copia de la base de datos para deploy-vps.bat, que la guarda en el PC.
# Todo mensaje va a stderr: stdout lleva el archivo y cualquier texto lo corrompería.
if [ "${1:-}" = "--backup-db" ]; then
  DB="$APP_DIR/minios.db"
  if [ ! -f "$DB" ]; then
    echo "No hay base de datos en la VPS todavía (instalación nueva)." >&2
    exit 3
  fi
  TMP=$(mktemp)
  trap 'rm -f "$TMP"' EXIT
  # .backup da una copia consistente aunque el backend esté escribiendo (WAL)
  sqlite3 "$DB" ".backup '$TMP'" >&2
  cat "$TMP"
  # El .bat compara este hash con el del archivo recibido
  echo "SHA256=$(sha256sum "$TMP" | cut -d' ' -f1)" >&2
  exit 0
fi

DOMAIN="${1:?Falta el dominio}"
EMAIL="${2:?Falta el email para el certificado HTTPS}"
DEVICE_TOKEN_IN="${3:-}"
BRANCH="${4:-main}"
SSH_PORT_IN="${5:-}"

log()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠  %s\033[0m\n' "$*"; }
as_app() { sudo -u "$APP_USER" -H bash -lc "$*"; }

[ "$(id -u)" -eq 0 ] || { echo "Hay que ejecutarlo como root."; exit 1; }

. /etc/os-release
case "$ID" in
  ubuntu|debian) ;;
  *) echo "Solo probado en Ubuntu/Debian (este sistema es: $ID)."; exit 1 ;;
esac

# Sin esto apt y needrestart se quedan esperando respuestas en pantallas azules
export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

# ------------------------------------------------------------------
log "1/9 Paquetes del sistema"
# ------------------------------------------------------------------
apt-get update -y
apt-get -y -o Dpkg::Options::="--force-confdef" -o Dpkg::Options::="--force-confold" upgrade
# build-essential y python3: por si better-sqlite3 o bcrypt no tienen binario
# precompilado para esta versión de Node y hay que compilarlos
apt-get install -y git curl ca-certificates gnupg sudo ufw nginx certbot \
  python3-certbot-nginx build-essential python3 sqlite3 dnsutils

# ------------------------------------------------------------------
log "2/9 Memoria swap (para compilar en VPS pequeñas)"
# ------------------------------------------------------------------
# Compilar better-sqlite3 con menos de 2 GB de RAM puede matar a npm por falta
# de memoria. Se crea un swap de 2 GB solo si no hay ninguno.
RAM_MB=$(awk '/MemTotal/ {print int($2/1024)}' /proc/meminfo)
if [ "$RAM_MB" -lt 2000 ] && [ -z "$(swapon --show --noheadings)" ]; then
  fallocate -l 2G /swapfile || dd if=/dev/zero of=/swapfile bs=1M count=2048
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "Swap de 2 GB creado (RAM: ${RAM_MB} MB)"
else
  echo "No hace falta (RAM: ${RAM_MB} MB, swap: $(swapon --show --noheadings | wc -l) activo/s)"
fi

# ------------------------------------------------------------------
log "3/9 Node.js $NODE_MAJOR LTS"
# ------------------------------------------------------------------
CURRENT_NODE=$(command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo 0)
if [ "$CURRENT_NODE" -lt "$NODE_MAJOR" ]; then
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi
echo "node $(node --version) · npm $(npm --version)"

# ------------------------------------------------------------------
log "4/9 PM2"
# ------------------------------------------------------------------
command -v pm2 >/dev/null || npm install -g pm2
pm2 --version

# ------------------------------------------------------------------
log "5/9 Firewall (SSH + HTTP/HTTPS)"
# ------------------------------------------------------------------
# Se abren los puertos de SSH ANTES de activar ufw: si SSH no va por el 22 y
# solo se abre OpenSSH, te quedas fuera de la VPS. Se suman el puerto que usa
# el deploy, los de sshd -T (configurados) y los de ss (escuchando ahora; en
# Ubuntu 24.04 el socket lo abre systemd y ss no muestra "sshd").
SSH_PORTS=$( { [ -n "$SSH_PORT_IN" ] && echo "$SSH_PORT_IN";
               sshd -T 2>/dev/null | awk '$1 == "port" {print $2}';
               ss -Htlnp 2>/dev/null | awk '/sshd/ {n = split($4, a, ":"); print a[n]}'; } | grep -E '^[0-9]+$' | sort -u || true)
if [ -z "$SSH_PORTS" ]; then
  ufw allow OpenSSH
fi
for port in $SSH_PORTS; do
  ufw allow "$port/tcp"
done
echo "Puertos SSH abiertos: ${SSH_PORTS:-22 (OpenSSH)}"
ufw allow 'Nginx Full'
ufw --force enable
ufw status

# ------------------------------------------------------------------
log "6/9 Usuario '$APP_USER' y código"
# ------------------------------------------------------------------
if ! id "$APP_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$APP_USER"
fi

if [ -d "$APP_DIR/.git" ]; then
  # Actualización: copia de la base de datos antes de tocar nada
  if [ -f "$APP_DIR/minios.db" ]; then
    BACKUP="$APP_DIR/minios.db.backup.$(date +%Y%m%d_%H%M%S)"
    as_app "sqlite3 '$APP_DIR/minios.db' \".backup '$BACKUP'\""
    echo "Backup de la base de datos: $BACKUP"
  fi
  as_app "cd '$APP_DIR' && git fetch origin && git checkout '$BRANCH' && git pull --ff-only origin '$BRANCH'"
else
  as_app "git clone --branch '$BRANCH' '$REPO_URL' '$APP_DIR'"
fi
as_app "cd '$APP_DIR' && git log --oneline -1"

as_app "cd '$APP_DIR' && npm install --omit=dev --no-package-lock --no-audit --no-fund"

# ------------------------------------------------------------------
log "7/9 Archivo .env"
# ------------------------------------------------------------------
ENV_FILE="$APP_DIR/.env"
if [ -f "$ENV_FILE" ]; then
  echo "Ya existe: se conserva tal cual (no se regeneran secretos)."
else
  JWT_SECRET=$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")
  case "$DEVICE_TOKEN_IN" in
    "")  DEVICE_TOKEN=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))") ;;
    "-") DEVICE_TOKEN="" ;;
    *)   DEVICE_TOKEN="$DEVICE_TOKEN_IN" ;;
  esac

  cat > "$ENV_FILE" <<EOF
PORT=$APP_PORT
JWT_SECRET=$JWT_SECRET
DEVICE_TOKEN=$DEVICE_TOKEN
ALLOWED_ORIGINS=
DATA_RETENTION_DAYS=30
MAX_FIRMWARE_MB=8
AUDIO_MAX_PER_DEVICE=200
EOF
  chown "$APP_USER:$APP_USER" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  echo "Creado con secretos nuevos."
fi

# ------------------------------------------------------------------
log "8/9 Arranque con PM2"
# ------------------------------------------------------------------
as_app "cd '$APP_DIR' && if pm2 describe minios >/dev/null 2>&1; then pm2 reload minios --update-env; else pm2 start src/index.js --name minios; fi && pm2 save"
# Servicio systemd para que arranque solo tras reiniciar la VPS
pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null
systemctl enable "pm2-$APP_USER" >/dev/null 2>&1 || true

# Esperar a que responda
for i in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$APP_PORT/api/time" >/dev/null 2>&1 && break
  sleep 1
done
if curl -fsS "http://127.0.0.1:$APP_PORT/api/time" >/dev/null 2>&1; then
  echo "Backend respondiendo en el puerto $APP_PORT"
else
  warn "El backend no responde. Revisa: sudo -u $APP_USER pm2 logs minios"
fi

# ------------------------------------------------------------------
log "9/9 nginx y HTTPS"
# ------------------------------------------------------------------
SITE=/etc/nginx/sites-available/minios

# Si certbot ya añadió el bloque HTTPS no se sobrescribe: se perdería el SSL
if [ -f "$SITE" ] && grep -q "managed by Certbot" "$SITE"; then
  echo "Configuración de nginx con HTTPS ya presente: se conserva."
else
  cat > "$SITE" <<EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;

    # Firmware .bin (MAX_FIRMWARE_MB=8) y grabaciones de audio (máx. 960 KB)
    client_max_body_size 10M;

    location / {
        proxy_pass http://127.0.0.1:$APP_PORT;
        proxy_http_version 1.1;

        # WebSocket (dispositivos y dashboard)
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;

        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
fi

ln -sf "$SITE" /etc/nginx/sites-enabled/minios
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

# Let's Encrypt solo funciona si el dominio ya apunta a esta VPS
PUBLIC_IP=$(curl -4 -fsS --max-time 10 https://api.ipify.org || true)
DNS_IP=$(dig +short A "$DOMAIN" | grep -E '^[0-9.]+$' | tail -n1 || true)
HTTPS_OK=0

if [ -n "$PUBLIC_IP" ] && [ "$PUBLIC_IP" = "$DNS_IP" ]; then
  if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$EMAIL" --redirect --keep-until-expiring; then
    HTTPS_OK=1
  else
    warn "certbot falló. Puedes reintentarlo con: certbot --nginx -d $DOMAIN"
  fi
else
  warn "El dominio $DOMAIN apunta a '${DNS_IP:-nada}' y esta VPS es '${PUBLIC_IP:-desconocida}'."
  warn "Se omite HTTPS. Cuando el DNS apunte aquí, vuelve a ejecutar el deploy."
fi

# ------------------------------------------------------------------
# Resumen
# ------------------------------------------------------------------
TOKEN_NOW=$(grep '^DEVICE_TOKEN=' "$ENV_FILE" | cut -d= -f2- || true)
ADMIN_PW=$(grep -ho 'Contraseña: .*' "$APP_HOME/.pm2/logs/minios-out.log" 2>/dev/null | tail -n1 | sed 's/Contraseña: //' || true)

if [ "$HTTPS_OK" -eq 1 ]; then URL="https://$DOMAIN"; FW_PORT=443; else URL="http://${PUBLIC_IP:-$DOMAIN}"; FW_PORT=80; fi

printf '\n\033[1;32m%s\033[0m\n' "=============================================="
printf '\033[1;32m%s\033[0m\n'   " MiniOS Backend instalado"
printf '\033[1;32m%s\033[0m\n\n' "=============================================="
echo " Dashboard:   $URL"
echo " Usuario:     admin"
if [ -n "$ADMIN_PW" ]; then
  echo " Contraseña:  $ADMIN_PW   <- ANÓTALA y cámbiala en Configuración"
else
  echo " Contraseña:  la que ya tenías (la base de datos no es nueva)"
fi
echo
echo " En cada ESP32, por el monitor serie (115200):"
echo "   server $DOMAIN $FW_PORT"
if [ -n "$TOKEN_NOW" ]; then
  echo "   token $TOKEN_NOW"
else
  echo "   token -        (el backend no exige token)"
fi
echo "   reboot"
echo
echo " Logs:        sudo -u $APP_USER pm2 logs minios"
echo " Actualizar:  vuelve a ejecutar deploy-vps.bat"
echo
