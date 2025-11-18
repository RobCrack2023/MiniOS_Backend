# MiniOS Backend

Backend centralizado para gestionar dispositivos ESP32 con MiniOS WiFi.

## Requisitos

- Node.js 18+
- npm

## Instalación

```bash
# Instalar dependencias
npm install

# Iniciar en desarrollo
npm run dev

# Iniciar en producción
npm start
```

## Configuración

Variables de entorno (opcional):

```bash
PORT=3000
JWT_SECRET=tu-clave-secreta-aqui
```

## Primer Uso

1. Iniciar el servidor: `npm start`
2. Abrir en navegador: `http://localhost:3000`
3. Usuario por defecto: `admin` / `admin123`
4. **Cambiar la contraseña inmediatamente**

## API Endpoints

### Autenticación
- `POST /api/auth/login` - Iniciar sesión
- `GET /api/auth/verify` - Verificar token
- `POST /api/auth/change-password` - Cambiar contraseña

### Dispositivos
- `GET /api/devices` - Listar dispositivos
- `GET /api/devices/:id` - Obtener dispositivo
- `PUT /api/devices/:id` - Actualizar dispositivo
- `DELETE /api/devices/:id` - Eliminar dispositivo

### GPIO
- `GET /api/devices/:id/gpio` - Obtener configuración GPIO
- `POST /api/devices/:id/gpio` - Configurar GPIO
- `POST /api/devices/:id/gpio/:pin/set` - Establecer valor GPIO

### DHT
- `GET /api/devices/:id/dht` - Obtener configuración DHT
- `POST /api/devices/:id/dht` - Configurar DHT

### Firmware / OTA
- `GET /api/ota/firmware` - Listar firmware
- `POST /api/ota/firmware/upload` - Subir firmware
- `POST /api/ota/firmware/:id/activate` - Activar firmware
- `POST /api/ota/update/:deviceId` - Actualizar dispositivo
- `POST /api/ota/update-all` - Actualizar todos

## WebSocket

### Endpoints
- `/ws/device` - Conexión para dispositivos ESP32
- `/ws/dashboard` - Conexión para dashboard web

### Mensajes del Dispositivo al Backend

```json
{
  "type": "register",
  "mac_address": "AA:BB:CC:DD:EE:FF",
  "firmware_version": "1.0.0",
  "ip_address": "192.168.1.100"
}

{
  "type": "data",
  "mac_address": "AA:BB:CC:DD:EE:FF",
  "payload": {
    "temperature": 25.5,
    "humidity": 60,
    "gpio": [{"pin": 2, "value": 1}]
  }
}
```

### Mensajes del Backend al Dispositivo

```json
{
  "type": "config",
  "device_id": 1,
  "gpio": [...],
  "dht": [...],
  "ota": null
}

{
  "type": "command",
  "action": "set_gpio",
  "pin": 2,
  "value": 1
}

{
  "type": "command",
  "action": "ota_update",
  "ota_id": 1,
  "version": "1.0.1",
  "filename": "firmware.bin",
  "checksum": "abc123",
  "filesize": 512000
}
```

## Estructura del Proyecto

```
MiniOS_Backend/
├── src/
│   ├── index.js           # Entry point
│   ├── websocket.js       # WebSocket server
│   ├── db/
│   │   ├── database.js    # SQLite wrapper
│   │   └── schema.sql     # Database schema
│   └── routes/
│       ├── api.js         # REST API
│       ├── auth.js        # Authentication
│       └── ota.js         # OTA management
├── public/                # Dashboard web
├── firmware/              # Uploaded .bin files
├── minios.db              # SQLite database
└── package.json
```

## Despliegue en VPS

### Con PM2

```bash
# Instalar PM2
npm install -g pm2

# Iniciar aplicación
pm2 start src/index.js --name minios

# Auto-inicio en reboot
pm2 startup
pm2 save
```

### Con Nginx (proxy inverso)

```nginx
server {
    listen 80;
    server_name tu-dominio.com;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

## Licencia

MIT
