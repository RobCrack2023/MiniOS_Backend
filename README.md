# MiniOS Backend

Backend centralizado para gestionar dispositivos ESP32 con MiniOS WiFi Client.

## Stack

- **Runtime**: Node.js 18+
- **Framework**: Fastify
- **Base de datos**: SQLite (better-sqlite3, WAL mode)
- **Autenticación**: JWT
- **Tiempo real**: WebSocket (ws)
- **Frontend**: AlpineJS + Chart.js (dashboard embebido)

## Sensores Soportados

| Sensor | Protocolo | Datos |
|--------|-----------|-------|
| DHT11 / DHT22 | Digital 1-wire | Temperatura, Humedad |
| AHT20 | I2C (0x38) | Temperatura, Humedad |
| BMP280 | I2C (0x76 / 0x77) | Temperatura, Presión, Altitud |
| HC-SR04 | Digital TRIG/ECHO | Distancia (cm) |
| GPIO OUTPUT | Digital | Control (ON/OFF) |
| GPIO PWM | Digital | Control (0–255) |
| GPIO INPUT | Digital / Analógico | Lectura |

---

## Instalación Local

```bash
npm install
npm run dev   # desarrollo (nodemon)
npm start     # producción
```

Abrir en navegador: `http://localhost:3001`
Usuario por defecto: **admin / admin123** — cambiar inmediatamente en Configuración.

## Variables de Entorno

Crear un archivo `.env` en la raíz del proyecto (opcional, hay valores por defecto):

```bash
PORT=3001
JWT_SECRET=cambia-esto-por-una-clave-segura
```

> **Nota sobre Timezone**: Los timestamps se almacenan siempre en **UTC** en la base de datos.
> La conversión a zona horaria local ocurre **en el frontend**, usando la zona configurada en
> el dashboard (Configuración → Zona Horaria). No es necesario configurar `TZ` en el servidor.

---

## Despliegue por Primera Vez en VPS Ubuntu

### 1. Preparar el servidor

```bash
# Conectarse al VPS
ssh root@tu-servidor.com

# Actualizar sistema
apt update && apt upgrade -y

# Instalar herramientas básicas
apt install -y git curl ufw nginx certbot python3-certbot-nginx
```

### 2. Instalar Node.js 20 LTS

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs
node --version   # debe mostrar v20.x.x
```

### 3. Instalar PM2

```bash
npm install -g pm2
```

### 4. Configurar el firewall

```bash
ufw allow OpenSSH
ufw allow 'Nginx Full'   # abre puertos 80 y 443
ufw enable
ufw status
```

### 5. Clonar y configurar el proyecto

```bash
# Crear usuario no-root para la aplicación (recomendado)
adduser minios
usermod -aG sudo minios
su - minios

# Clonar el repositorio
git clone https://github.com/tu-usuario/MiniOS_Backend.git
cd MiniOS_Backend

# Instalar dependencias
npm install --production

# Crear archivo de variables de entorno
cat > .env << 'EOF'
PORT=3001
JWT_SECRET=genera-una-clave-larga-y-aleatoria-aqui
EOF

chmod 600 .env
```

### 6. Iniciar con PM2

```bash
# Iniciar la aplicación
pm2 start src/index.js --name minios

# Configurar auto-inicio al reiniciar el servidor
pm2 startup systemd
# Ejecutar el comando que PM2 muestra (empieza con "sudo env PATH=...")

pm2 save

# Verificar que funciona
pm2 status
pm2 logs minios --lines 30
```

### 7. Configurar Nginx como proxy inverso

```bash
# Crear configuración de Nginx
sudo nano /etc/nginx/sites-available/minios
```

Pegar la siguiente configuración (reemplazar `tu-dominio.com`):

```nginx
server {
    listen 80;
    server_name tu-dominio.com;

    # Aumentar límite para subida de firmware .bin
    client_max_body_size 10M;

    location / {
        proxy_pass http://localhost:3001;
        proxy_http_version 1.1;

        # Headers para WebSocket
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # Timeouts para conexiones WebSocket de larga duración
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

```bash
# Activar el sitio
sudo ln -s /etc/nginx/sites-available/minios /etc/nginx/sites-enabled/
sudo nginx -t   # verificar configuración
sudo systemctl reload nginx
```

### 8. Configurar SSL con Let's Encrypt

```bash
sudo certbot --nginx -d tu-dominio.com
# Certbot modifica el nginx.conf automáticamente para HTTPS

# Verificar renovación automática
sudo certbot renew --dry-run
```

### 9. Verificación final

```bash
# Verificar PM2
pm2 status

# Verificar Nginx
sudo systemctl status nginx

# Probar HTTP (debe redirigir a HTTPS)
curl -I http://tu-dominio.com

# Probar HTTPS
curl -I https://tu-dominio.com

# Ver logs en tiempo real
pm2 logs minios
```

El dashboard estará disponible en `https://tu-dominio.com`.
El ESP32 debe apuntar a `tu-dominio.com` en puerto **443** (SSL).

---

## Actualizar el Servidor de Producción

### Proceso estándar

```bash
# 1. Conectarse al servidor
ssh minios@tu-servidor.com
cd ~/MiniOS_Backend

# 2. Backup de la base de datos (SIEMPRE antes de actualizar)
cp minios.db minios.db.backup.$(date +%Y%m%d_%H%M%S)

# 3. Obtener los últimos cambios
git pull origin main

# 4. Instalar nuevas dependencias (si las hay)
npm install --production

# 5. Reiniciar con PM2 (zero-downtime reload cuando sea posible)
pm2 reload minios

# 6. Verificar que todo funciona
pm2 logs minios --lines 50
```

### Si hubo cambios en el schema de la DB

El backend aplica el schema automáticamente al iniciar usando `IF NOT EXISTS`.
Para **nuevas columnas** en tablas existentes, ejecutar manualmente:

```bash
# Conectarse a la base de datos SQLite
sqlite3 minios.db

# Ejemplo: agregar una columna nueva
ALTER TABLE devices ADD COLUMN nueva_columna TEXT;

# Salir
.quit
```

### Rollback en caso de problemas

```bash
# Ver commits recientes
git log --oneline -5

# Volver al commit anterior
git reset --hard HEAD~1

# Restaurar backup de la DB si es necesario
cp minios.db.backup.YYYYMMDD_HHMMSS minios.db

# Reiniciar
pm2 restart minios
pm2 logs minios --lines 30
```

### Comandos PM2 útiles

```bash
pm2 status              # estado de todos los procesos
pm2 logs minios         # logs en tiempo real
pm2 logs minios --lines 100   # últimas 100 líneas
pm2 restart minios      # reinicio completo
pm2 reload minios       # reinicio sin downtime
pm2 stop minios         # detener
pm2 monit               # monitor interactivo (CPU, RAM)
```

---

## API Reference

Todos los endpoints (excepto auth y `/api/time`) requieren header:
```
Authorization: Bearer <token>
```

### Autenticación
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/auth/login` | Iniciar sesión |
| GET | `/api/auth/verify` | Verificar token JWT |
| POST | `/api/auth/setup` | Crear primer usuario (solo si no hay usuarios) |
| POST | `/api/auth/change-password` | Cambiar contraseña |

### Tiempo (sin auth)
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/time` | Timestamp UTC + timezone configurada (usado por ESP32) |

### Dispositivos
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/devices` | Listar todos los dispositivos |
| GET | `/api/devices/:id` | Obtener dispositivo + todas sus configuraciones |
| PUT | `/api/devices/:id` | Actualizar nombre/descripción |
| DELETE | `/api/devices/:id` | Eliminar dispositivo y todos sus datos |
| POST | `/api/devices/:id/reboot` | Reiniciar (encola si está offline) |

### GPIO
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/devices/:id/gpio` | Listar configuraciones GPIO |
| POST | `/api/devices/:id/gpio` | Crear/actualizar configuración GPIO |
| DELETE | `/api/devices/:id/gpio/:pin` | Eliminar configuración GPIO |
| POST | `/api/devices/:id/gpio/:pin/set` | Enviar valor al pin (encola si offline) |

### Sensores DHT
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/devices/:id/dht` | Listar sensores DHT configurados |
| POST | `/api/devices/:id/dht` | Agregar/actualizar sensor DHT |
| DELETE | `/api/devices/:id/dht/:pin` | Eliminar sensor DHT |

### Sensores I2C (AHT20, BMP280, BME280)
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/devices/:id/i2c` | Listar sensores I2C configurados |
| POST | `/api/devices/:id/i2c` | Agregar/actualizar sensor I2C |
| DELETE | `/api/devices/:id/i2c/:address` | Eliminar sensor I2C por dirección |
| POST | `/api/devices/:id/i2c/scan` | Solicitar escaneo del bus I2C (encola si offline) |

### Sensores Ultrasónicos HC-SR04
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/devices/:id/ultrasonic` | Listar sensores ultrasónicos |
| POST | `/api/devices/:id/ultrasonic` | Agregar/actualizar sensor ultrasónico |
| DELETE | `/api/devices/:id/ultrasonic/:id` | Eliminar sensor ultrasónico |

### Datos de Sensores (Historial)
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/devices/:id/data` | Historial de lecturas. Query params: `type` (sensor_type), `limit` (default 100) |
| GET | `/api/devices/:id/summary` | Última lectura de cada tipo de sensor |

### Sistema
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/system/stats` | Estadísticas: total/online/offline dispositivos |
| GET | `/api/settings/timezone` | Obtener timezone configurada |
| PUT | `/api/settings/timezone` | Actualizar timezone |
| GET | `/api/settings` | Todas las configuraciones del sistema |

### Firmware / OTA
| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/ota/firmware` | Listar versiones de firmware |
| POST | `/api/ota/firmware/upload` | Subir nuevo firmware (.bin) |
| POST | `/api/ota/firmware/:id/activate` | Marcar firmware como activo |
| DELETE | `/api/ota/firmware/:id` | Eliminar firmware |
| POST | `/api/ota/update/:deviceId` | Enviar OTA a un dispositivo |
| POST | `/api/ota/update-all` | Enviar OTA a todos los dispositivos |

---

## WebSocket Protocol

### Endpoints
- `/ws/device` — conexión para dispositivos ESP32
- `/ws/dashboard` — conexión para el dashboard web

---

### Mensajes: ESP32 → Backend

**Registro** (al conectar):
```json
{
  "type": "register",
  "mac_address": "AA:BB:CC:DD:EE:FF",
  "firmware_version": "2.0.0",
  "ip_address": "192.168.1.100",
  "board_model": "ESP32",
  "board_family": "ESP32"
}
```

**Datos de sensores** (cada ciclo activo):
```json
{
  "type": "data",
  "mac_address": "AA:BB:CC:DD:EE:FF",
  "timestamp": 1705320600,
  "payload": {
    "dht": [
      { "pin": 4, "name": "DHT Interior", "temperature": 23.5, "humidity": 61.0 }
    ],
    "i2c": [
      { "id": 1, "sensor_type": "AHT20", "i2c_address": 56, "temperature": 22.8, "humidity": 58.5 },
      { "id": 2, "sensor_type": "BMP280", "i2c_address": 118, "temperature": 23.1, "pressure": 1013.2, "altitude": 45.0 }
    ],
    "gpio": [
      { "pin": 34, "value": 2048, "analog": true },
      { "pin": 5, "value": 1, "analog": false }
    ],
    "ultrasonic": [
      { "id": 1, "trig_pin": 12, "echo_pin": 13, "distance": 34.2, "triggered": false }
    ]
  }
}
```

**Resultado de escaneo I2C**:
```json
{
  "type": "i2c_scan_result",
  "devices": [
    { "address": 56, "sensor_type": "AHT20" },
    { "address": 118, "sensor_type": "BMP280" }
  ]
}
```

**Estado OTA**:
```json
{
  "type": "ota_status",
  "mac_address": "AA:BB:CC:DD:EE:FF",
  "ota_id": 1,
  "status": "success",
  "error": null
}
```

---

### Mensajes: Backend → ESP32

**Configuración inicial** (respuesta al register):
```json
{
  "type": "config",
  "device_id": 1,
  "gpio": [ { "pin": 5, "mode": "OUTPUT", "name": "Relay", "value": 0 } ],
  "dht": [ { "pin": 4, "sensor_type": "DHT22", "name": "Interior", "read_interval": 5000 } ],
  "i2c": [ { "id": 1, "sensor_type": "AHT20", "i2c_address": 56, "name": "AHT20 Principal" } ],
  "ultrasonic": [ { "id": 1, "trig_pin": 12, "echo_pin": 13, "name": "Sensor Entrada" } ],
  "ota": null
}
```

**Comandos** (`type: "command"`):

| `action` | Descripción | Campos adicionales |
|----------|-------------|-------------------|
| `set_gpio` | Establecer valor de un GPIO | `pin`, `value` |
| `update_gpio` | Reemplazar toda la configuración GPIO | `gpio: [...]` |
| `remove_gpio` | Eliminar un GPIO | `pin` |
| `update_dht` | Reemplazar configuración DHT | `dht: [...]` |
| `remove_dht` | Eliminar un sensor DHT | `pin` |
| `update_i2c` | Reemplazar configuración I2C | `i2c: [...]` |
| `remove_i2c` | Eliminar un sensor I2C | `i2c_address` |
| `scan_i2c` | Escanear bus I2C y reportar | — |
| `update_ultrasonic` | Reemplazar configuración ultrasónica | `ultrasonic: [...]` |
| `reboot` | Reiniciar el dispositivo | — |
| `ota_update` | Iniciar actualización OTA | `ota_id`, `filename`, `filesize`, `checksum` |

---

### Mensajes: Backend → Dashboard

| `type` | Descripción |
|--------|-------------|
| `init` | Lista completa de dispositivos al conectar |
| `device_online` | Dispositivo conectado (objeto device completo) |
| `device_offline` | Dispositivo desconectado (`mac_address`, `last_seen`) |
| `device_data` | Nuevas lecturas de sensores (`mac_address`, `device_id`, `payload`, `last_seen`) |
| `i2c_scan_result` | Resultado de escaneo I2C (`devices: [...]`) |
| `ota_status` | Estado de actualización OTA |

---

## Deep Sleep y Comandos Pendientes

Los ESP32 operan en ciclos de **Deep Sleep** (60s dormido / ~18s activo). Para garantizar
que los comandos enviados mientras el dispositivo duerme no se pierdan:

1. Si el dispositivo está **offline**, el comando se guarda en la tabla `pending_commands`
2. Al reconectarse, el backend envía los comandos pendientes **antes** de cualquier otra operación
3. El ESP32 procesa los pendientes en los primeros 3 segundos (drain phase)
4. Luego mantiene una ventana de 15 segundos para comandos en tiempo real

---

## Estructura del Proyecto

```
MiniOS_Backend/
├── src/
│   ├── index.js           # Entry point, configuración Fastify
│   ├── websocket.js       # WebSocket server (dispositivos + dashboard)
│   ├── db/
│   │   ├── database.js    # SQLite wrapper (better-sqlite3)
│   │   └── schema.sql     # Schema de la base de datos
│   └── routes/
│       ├── api.js         # REST API (devices, GPIO, DHT, I2C, ultrasonic, data)
│       ├── auth.js        # Autenticación JWT
│       └── ota.js         # Gestión de firmware OTA
├── public/                # Dashboard web (HTML + CSS + JS)
│   ├── dashboard.html
│   ├── css/style.css
│   └── js/app.js
├── firmware/              # Archivos .bin subidos para OTA
├── minios.db              # Base de datos SQLite (generada al iniciar)
├── .env                   # Variables de entorno (no subir al repo)
└── package.json
```

## Licencia

MIT
